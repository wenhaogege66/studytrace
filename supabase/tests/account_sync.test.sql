-- StudyTrace account continuity acceptance tests.
-- Run after the normal database migration stack in an isolated database.

begin;

do $$
declare
  function_name text;
begin
  foreach function_name in array array[
    'public.touch_my_activity()',
    'public.get_my_account_transfer_summary()',
    'public.prepare_account_merge(text,text)',
    'public.refresh_account_merge(text)',
    'public.consume_account_merge(text)',
    'public.cancel_account_merge(text)',
    'public.prepare_account_deletion(text)',
    'public.refresh_account_deletion(text)',
    'public.cancel_account_deletion(text)',
    'public.delete_my_account(text)'
  ] loop
    if has_function_privilege('anon', function_name, 'execute') then
      raise exception 'anon must not execute %', function_name;
    end if;
    if not has_function_privilege('authenticated', function_name, 'execute') then
      raise exception 'authenticated must execute %', function_name;
    end if;
  end loop;

  if has_schema_privilege('authenticated', 'private', 'usage') then
    raise exception 'authenticated must not access the private schema';
  end if;
end;
$$;

do $$
declare
  function_name text;
  definition text;
  owner_marker constant text := 'studytrace:owner-mutation:';
  marker_count integer;
  owner_position integer;
  row_lock_position integer;
  legacy_advisory_position integer;
begin
  foreach function_name in array array[
    'public.delete_my_data()',
    'public.set_task_step_completed(uuid,text,boolean)',
    'public.start_study_session(uuid,boolean,boolean)',
    'public.finish_study_session(uuid,integer,text)',
    'public.cancel_study_session(uuid,integer)',
    'public.checkpoint_running_session(uuid,timestamptz,integer,timestamptz)',
    'public.pause_study_session(uuid,bigint,integer)',
    'public.resume_study_session(uuid,bigint)',
    'public.set_study_session_camera(uuid,bigint,bigint,boolean)',
    'public.pause_study_session_for_navigation(uuid)',
    'public.confirm_task_completion(uuid,integer)',
    'public.reopen_completed_task(uuid)'
  ] loop
    definition := lower(pg_get_functiondef(function_name::regprocedure));
    marker_count := (
      char_length(definition)
      - char_length(replace(definition, owner_marker, ''))
    ) / char_length(owner_marker);
    owner_position := strpos(definition, owner_marker);
    row_lock_position := strpos(definition, 'for update');
    legacy_advisory_position := strpos(
      definition,
      'hashtextextended(current_user_id::text'
    );

    if marker_count <> 1 then
      raise exception '% has % owner guards instead of one',
        function_name, marker_count;
    end if;
    if row_lock_position > 0 and owner_position > row_lock_position then
      raise exception '% locks a row before its owner guard', function_name;
    end if;
    if legacy_advisory_position > 0
      and owner_position > legacy_advisory_position
    then
      raise exception '% takes its legacy advisory before owner guard',
        function_name;
    end if;
  end loop;

  if (
    select count(*)
    from pg_trigger as trigger
    join pg_class as relation on relation.oid = trigger.tgrelid
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname in (
        'tasks',
        'study_sessions',
        'behavior_events',
        'reminder_events',
        'reviews',
        'user_settings'
      )
      and trigger.tgname = 'a0_lock_account_owner_mutation'
      and not trigger.tgisinternal
      and trigger.tgenabled <> 'D'
      and (trigger.tgtype::integer & 1) = 0
      and (trigger.tgtype::integer & 2) = 2
      and (trigger.tgtype::integer & 28) = 28
  ) <> 6 then
    raise exception 'owner BEFORE STATEMENT guard is missing on a public table';
  end if;
end;
$$;

insert into auth.users (
  id,
  aud,
  role,
  email,
  encrypted_password,
  raw_app_meta_data,
  raw_user_meta_data,
  is_anonymous,
  email_confirmed_at,
  last_sign_in_at,
  created_at,
  updated_at
)
values
  (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'authenticated',
    'authenticated',
    null,
    '',
    '{"provider":"anonymous","providers":["anonymous"]}',
    '{}',
    true,
    null,
    now(),
    now(),
    now()
  ),
  (
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'authenticated',
    'authenticated',
    'account-sync@example.com',
    '',
    '{"provider":"email","providers":["email"]}',
    '{}',
    false,
    now(),
    now(),
    now(),
    now()
  ),
  (
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'authenticated',
    'authenticated',
    'different-account@example.com',
    '',
    '{"provider":"email","providers":["email"]}',
    '{}',
    false,
    now(),
    now(),
    now(),
    now()
  ),
  (
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'authenticated',
    'authenticated',
    null,
    '',
    '{"provider":"anonymous","providers":["anonymous"]}',
    '{}',
    true,
    null,
    now(),
    now(),
    now()
  ),
  (
    '99999999-9999-4999-8999-999999999999',
    'authenticated',
    'authenticated',
    null,
    '',
    '{"provider":"anonymous","providers":["anonymous"]}',
    '{}',
    true,
    null,
    now(),
    now(),
    now()
  );

insert into auth.sessions (id, user_id, created_at, updated_at)
values
  (
    '10000000-0000-4000-8000-0000000000e1',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    now(),
    now()
  ),
  (
    '10000000-0000-4000-8000-0000000000e2',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    now(),
    now()
  ),
  (
    '10000000-0000-4000-8000-0000000000d1',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    now(),
    now()
  ),
  (
    '10000000-0000-4000-8000-0000000000c1',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    now(),
    now()
  ),
  (
    '10000000-0000-4000-8000-000000000091',
    '99999999-9999-4999-8999-999999999999',
    now(),
    now()
  );

insert into public.user_settings (user_id)
values
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ('99999999-9999-4999-8999-999999999999');

update public.user_settings
set reminders_enabled = false
where user_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

insert into public.tasks (
  id,
  user_id,
  title,
  steps,
  priority,
  estimated_minutes
)
values (
  '30000000-0000-4000-8000-000000000001',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  '待合并的匿名任务',
  '[{"id":"step-1","title":"完成一步","completed":true}]',
  'medium',
  25
);

select set_config(
  'request.jwt.claim.sub',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-0000000000e1',
    'amr', jsonb_build_array(
      jsonb_build_object(
        'method', 'anonymous',
        'timestamp', floor(extract(epoch from clock_timestamp()))::bigint
      )
    )
  )::text,
  true
);

insert into public.study_sessions (
  id,
  user_id,
  task_id,
  status,
  accumulated_seconds,
  resumed_at
)
values (
  '40000000-0000-4000-8000-000000000001',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  '30000000-0000-4000-8000-000000000001',
  'running',
  900,
  now()
);

insert into public.behavior_events (
  id,
  user_id,
  session_id,
  event_type,
  direction,
  source,
  started_at,
  ended_at,
  review_status
)
values (
  '50000000-0000-4000-8000-000000000001',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  '40000000-0000-4000-8000-000000000001',
  'head_direction_change',
  'left',
  'vision',
  now() - interval '20 seconds',
  now() - interval '5 seconds',
  'confirmed'
);

insert into public.reminder_events (
  id,
  user_id,
  session_id,
  behavior_event_id,
  response,
  responded_at
)
values (
  '60000000-0000-4000-8000-000000000001',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  '40000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001',
  'back_to_task',
  now()
);

-- Exercise the three owner-guarded SECURITY INVOKER functions through the
-- authenticated role; private helper permissions must not leak to the client.
insert into public.tasks (
  id,
  user_id,
  title,
  steps,
  priority,
  estimated_minutes,
  status,
  completed_at
)
values (
  '30000000-0000-4000-8000-000000000099',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'Invoker owner guard smoke',
  '[{"id":"invoker-step","title":"重开","completed":true}]',
  'low',
  5,
  'completed',
  now()
);

set local role authenticated;
select public.set_task_step_completed(
  '30000000-0000-4000-8000-000000000001',
  'step-1',
  false
);
select public.set_task_step_completed(
  '30000000-0000-4000-8000-000000000001',
  'step-1',
  true
);
select public.checkpoint_running_session(
  '40000000-0000-4000-8000-000000000001',
  (
    select resumed_at
    from public.study_sessions
    where id = '40000000-0000-4000-8000-000000000001'
  ),
  900,
  clock_timestamp()
);
select public.reopen_completed_task(
  '30000000-0000-4000-8000-000000000099'
);
delete from public.tasks
where id = '30000000-0000-4000-8000-000000000099';
reset role;

update public.study_sessions
set
  status = 'completed',
  resumed_at = null,
  ended_at = now()
where id = '40000000-0000-4000-8000-000000000001';

insert into public.reviews (
  id,
  user_id,
  session_id,
  completion_status,
  self_rating,
  next_adjustment
)
values (
  '70000000-0000-4000-8000-000000000001',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  '40000000-0000-4000-8000-000000000001',
  'completed',
  4,
  '下次继续'
);

-- Both identities have used the task planner recently. The transfer must carry
-- the anonymous usage into the permanent account instead of resetting it.
insert into private.ai_generation_quota (
  user_id,
  window_started_at,
  attempts
)
values
  (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    clock_timestamp() - interval '1 minute',
    5
  ),
  (
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    clock_timestamp() - interval '2 minutes',
    4
  );

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

select public.prepare_account_merge(
  repeat('a', 64),
  'account-sync@example.com'
);

-- Retrying the exact same prepared bearer is idempotent, so a lost response
-- never strands the anonymous records. A different concurrent bearer fails.
reset role;
update private.user_activity
set last_active_at = clock_timestamp() - interval '31 days'
where user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

set local role authenticated;
select public.prepare_account_merge(
  repeat('a', 64),
  'account-sync@example.com'
);

reset role;
do $$
begin
  if not exists (
    select 1
    from private.user_activity
    where user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
      and last_active_at > clock_timestamp() - interval '1 minute'
  ) then
    raise exception 'prepare_account_merge did not refresh source activity';
  end if;
end;
$$;

set local role authenticated;
do $$
declare
  conflicting_prepare_blocked boolean := false;
begin
  begin
    perform public.prepare_account_merge(
      repeat('b', 64),
      'account-sync@example.com'
    );
  exception
    when object_not_in_prerequisite_state then
      conflicting_prepare_blocked := true;
  end;

  if not conflicting_prepare_blocked then
    raise exception 'a concurrent merge bearer silently replaced the first';
  end if;
end;
$$;

reset role;
update private.user_activity
set last_active_at = clock_timestamp() - interval '31 days'
where user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

set local role authenticated;
select public.refresh_account_merge(repeat('a', 64));

reset role;
do $$
begin
  if not exists (
    select 1
    from private.user_activity
    where user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
      and last_active_at > clock_timestamp() - interval '1 minute'
  ) then
    raise exception 'refresh_account_merge did not refresh source activity';
  end if;
end;
$$;

set local role authenticated;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-0000000000e2',
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
  if public.cancel_account_merge(repeat('a', 64)) then
    raise exception 'a different source session cancelled the merge token';
  end if;
end;
$$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-0000000000e1',
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
declare
  refresh_after_cancel_blocked boolean := false;
begin
  if not public.cancel_account_merge(repeat('a', 64)) then
    raise exception 'merge cancellation did not revoke the prepared token';
  end if;

  if not public.cancel_account_merge(repeat('a', 64)) then
    raise exception 'absent merge cancellation was not idempotently accepted';
  end if;

  begin
    perform public.refresh_account_merge(repeat('a', 64));
  exception
    when insufficient_privilege then
      refresh_after_cancel_blocked := true;
  end;

  if not refresh_after_cancel_blocked then
    raise exception 'cancelled merge token could still be refreshed';
  end if;
end;
$$;

-- Cancellation releases the per-source unique slot immediately.
select public.prepare_account_merge(
  repeat('a', 64),
  'account-sync@example.com'
);

reset role;
insert into auth.sessions (id, user_id, created_at, updated_at)
values
  (
    '10000000-0000-4000-8000-0000000000f2',
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    clock_timestamp(),
    clock_timestamp()
  ),
  (
    '10000000-0000-4000-8000-0000000000f3',
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    clock_timestamp(),
    clock_timestamp()
  );

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
begin
  if (
    select tasks
    from jsonb_to_record(public.get_my_account_transfer_summary())
      as summary(tasks bigint)
  ) <> 1 then
    raise exception 'anonymous transfer summary did not count the task';
  end if;
end;
$$;

-- Correct email and session are still insufficient without a fresh email OTP.
select set_config(
  'request.jwt.claim.sub',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  true
);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-0000000000f2',
    'amr', jsonb_build_array(
      jsonb_build_object(
        'method', 'password',
        'timestamp', floor(extract(epoch from clock_timestamp()))::bigint
      )
    )
  )::text,
  true
);

do $$
declare
  password_amr_blocked boolean := false;
begin
  begin
    perform public.consume_account_merge(repeat('a', 64));
  exception
    when insufficient_privilege then
      password_amr_blocked := true;
  end;

  if not password_amr_blocked then
    raise exception 'password AMR bypassed merge email OTP verification';
  end if;
end;
$$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-0000000000f2',
    'amr', jsonb_build_array(
      jsonb_build_object('method', 'otp', 'timestamp', 0)
    )
  )::text,
  true
);

do $$
declare
  stale_otp_blocked boolean := false;
begin
  begin
    perform public.consume_account_merge(repeat('a', 64));
  exception
    when insufficient_privilege then
      stale_otp_blocked := true;
  end;

  if not stale_otp_blocked then
    raise exception 'stale OTP bypassed merge freshness verification';
  end if;
end;
$$;

reset role;
update auth.users
set
  raw_app_meta_data =
    '{"provider":"email","providers":["email","phone"]}',
  phone = '+15555550123',
  phone_confirmed_at = clock_timestamp()
where id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-0000000000f2',
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
  phone_provider_blocked boolean := false;
begin
  begin
    perform public.consume_account_merge(repeat('a', 64));
  exception
    when insufficient_privilege then
      phone_provider_blocked := true;
  end;

  if not phone_provider_blocked then
    raise exception 'multi-provider phone OTP was accepted as email verification';
  end if;
end;
$$;

reset role;
update auth.users
set
  raw_app_meta_data = '{"provider":"email","providers":["email"]}',
  phone = null,
  phone_confirmed_at = null
where id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
set local role authenticated;

select set_config(
  'request.jwt.claim.sub',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  true
);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-0000000000d1',
    'amr', jsonb_build_array(
      jsonb_build_object(
        'method', 'password',
        'timestamp', floor(extract(epoch from clock_timestamp()))::bigint
      )
    )
  )::text,
  true
);

do $$
declare
  wrong_email_blocked boolean := false;
begin
  begin
    perform public.consume_account_merge(repeat('a', 64));
  exception
    when insufficient_privilege then
      wrong_email_blocked := true;
  end;

  if not wrong_email_blocked then
    raise exception 'merge token was not bound to its target email';
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  true
);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-0000000000f2',
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
  first_result jsonb;
  retry_result jsonb;
  expected_result jsonb := jsonb_build_object(
    'tasks', 1,
    'sessions', 1,
    'behavior_events', 1,
    'reminder_events', 1,
    'reviews', 1
  );
begin
  first_result := public.consume_account_merge(repeat('a', 64));
  retry_result := public.consume_account_merge(repeat('a', 64));

  if first_result is distinct from expected_result then
    raise exception 'merge result counts were incorrect: %', first_result;
  end if;

  if retry_result is distinct from first_result then
    raise exception 'same-session retry did not return the original receipt';
  end if;
end;
$$;

do $$
begin
  if public.cancel_account_merge(repeat('a', 64)) then
    raise exception 'a consumed receipt was cancelled and lost';
  end if;
end;
$$;

-- The receipt is not a reusable account-level bearer. Even another fresh OTP
-- session for the same target user cannot retrieve it.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-0000000000f3',
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
  other_session_blocked boolean := false;
begin
  begin
    perform public.consume_account_merge(repeat('a', 64));
  exception
    when insufficient_privilege then
      other_session_blocked := true;
  end;

  if not other_session_blocked then
    raise exception 'merge receipt crossed target sessions';
  end if;
end;
$$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-0000000000f2',
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
begin
  if public.consume_account_merge(repeat('a', 64))
    is distinct from jsonb_build_object(
      'tasks', 1,
      'sessions', 1,
      'behavior_events', 1,
      'reminder_events', 1,
      'reviews', 1
    )
  then
    raise exception 'original target session could not recover its receipt';
  end if;
end;
$$;

reset role;

do $$
begin
  if not exists (
    select 1
    from public.tasks
    where id = '30000000-0000-4000-8000-000000000001'
      and user_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  ) then
    raise exception 'task ownership was not migrated';
  end if;

  if not exists (
    select 1
    from public.study_sessions
    where id = '40000000-0000-4000-8000-000000000001'
      and user_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  ) then
    raise exception 'terminal session ownership was not migrated';
  end if;

  if not exists (
    select 1
    from public.behavior_events
    where id = '50000000-0000-4000-8000-000000000001'
      and user_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  ) then
    raise exception 'behavior event ownership was not migrated';
  end if;

  if not exists (
    select 1
    from public.reminder_events
    where id = '60000000-0000-4000-8000-000000000001'
      and user_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  ) then
    raise exception 'reminder event ownership was not migrated';
  end if;

  if not exists (
    select 1
    from public.reviews
    where id = '70000000-0000-4000-8000-000000000001'
      and user_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  ) then
    raise exception 'review ownership was not migrated';
  end if;

  if exists (
    select 1 from auth.users
    where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  ) then
    raise exception 'anonymous source auth user still exists';
  end if;

  if not exists (
    select 1
    from public.user_settings
    where user_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      and reminders_enabled is false
  ) then
    raise exception 'permanent account settings were overwritten';
  end if;

  if not exists (
    select 1
    from private.account_merge_tokens
    where token_hash = extensions.digest(repeat('a', 64), 'sha256')
      and merge_state = 'consumed'
      and source_user_id is null
      and source_session_id is null
      and target_user_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      and target_session_id = '10000000-0000-4000-8000-0000000000f2'
      and expires_at > clock_timestamp()
  ) then
    raise exception 'merge receipt was not bound to the consuming user/session';
  end if;

  if exists (
    select 1
    from private.ai_generation_quota
    where user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  ) or not exists (
    select 1
    from private.ai_generation_quota
    where user_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      and attempts = 9
      and window_started_at > clock_timestamp() - interval '10 minutes'
  ) then
    raise exception 'AI generation quota was reset instead of combined';
  end if;
end;
$$;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-0000000000f2',
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
begin
  if public.consume_ai_generation_quota() then
    raise exception 'account merge reset the per-user AI quota';
  end if;
end;
$$;

reset role;

do $$
begin
  if not exists (
    select 1
    from private.ai_generation_quota
    where user_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      and attempts = 10
  ) then
    raise exception 'denied AI attempt was not counted after account merge';
  end if;
end;
$$;

do $$
declare
  updated_receipts bigint;
begin
  update private.account_merge_tokens
  set
    created_at = clock_timestamp() - interval '7 minutes',
    consumed_at = clock_timestamp() - interval '6 minutes',
    expires_at = clock_timestamp() - interval '1 minute'
  where token_hash = extensions.digest(repeat('a', 64), 'sha256')
    and merge_state = 'consumed';
  get diagnostics updated_receipts = row_count;

  if updated_receipts <> 1 then
    raise exception 'expected one consumed receipt to expire, got %',
      updated_receipts;
  end if;
end;
$$;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-0000000000f2',
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
  expired_receipt_blocked boolean := false;
begin
  begin
    perform public.consume_account_merge(repeat('a', 64));
  exception
    when insufficient_privilege then
      expired_receipt_blocked := true;
  end;

  if not expired_receipt_blocked then
    raise exception 'expired merge receipt was accepted';
  end if;
end;
$$;

reset role;

select set_config(
  'request.jwt.claim.sub',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  true
);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-0000000000c1',
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
  id,
  user_id,
  title,
  steps,
  priority,
  estimated_minutes
)
values (
  '30000000-0000-4000-8000-000000000002',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '活动会话阻断合并',
  '[{"id":"step-active","title":"未完成","completed":false}]',
  'low',
  10
);

insert into public.study_sessions (
  id,
  user_id,
  task_id,
  status,
  accumulated_seconds,
  resumed_at
)
values (
  '40000000-0000-4000-8000-000000000002',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '30000000-0000-4000-8000-000000000002',
  'running',
  0,
  now()
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  active_session_blocked boolean := false;
begin
  begin
    perform public.prepare_account_merge(
      repeat('c', 64),
      'account-sync@example.com'
    );
  exception
    when object_not_in_prerequisite_state then
      active_session_blocked := true;
  end;

  if not active_session_blocked then
    raise exception 'active anonymous session did not block merge preparation';
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  '99999999-9999-4999-8999-999999999999',
  true
);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '99999999-9999-4999-8999-999999999999',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-000000000091',
    'amr', jsonb_build_array(
      jsonb_build_object(
        'method', 'anonymous',
        'timestamp', floor(extract(epoch from clock_timestamp()))::bigint
      )
    )
  )::text,
  true
);

reset role;
update auth.sessions
set not_after = clock_timestamp() - interval '1 second'
where id = '10000000-0000-4000-8000-000000000091';

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  stale_session_blocked boolean := false;
begin
  begin
    perform public.prepare_account_merge(
      repeat('9', 64),
      'account-sync@example.com'
    );
  exception
    when insufficient_privilege then
      stale_session_blocked := true;
  end;

  if not stale_session_blocked then
    raise exception 'an expired auth session prepared a merge bearer';
  end if;
end;
$$;

reset role;
update auth.sessions
set not_after = null
where id = '10000000-0000-4000-8000-000000000091';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);

select public.prepare_account_merge(
  repeat('9', 64),
  'account-sync@example.com'
);

reset role;
insert into auth.sessions (id, user_id, created_at, updated_at)
values (
  '10000000-0000-4000-8000-0000000000f4',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  clock_timestamp(),
  clock_timestamp()
);
set local role authenticated;

-- After OTP switches the browser to the intended target, that exact fresh
-- session may revoke an unconsumed request. This keeps a deterministic
-- capacity failure cancellable even though the source session is no longer
-- installed in the main client.
select set_config(
  'request.jwt.claim.sub',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  true
);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-0000000000f4',
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
begin
  if not public.cancel_account_merge(repeat('9', 64)) then
    raise exception 'fresh target session could not cancel prepared merge';
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  '99999999-9999-4999-8999-999999999999',
  true
);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '99999999-9999-4999-8999-999999999999',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-000000000091',
    'amr', jsonb_build_array(
      jsonb_build_object(
        'method', 'anonymous',
        'timestamp', floor(extract(epoch from clock_timestamp()))::bigint
      )
    )
  )::text,
  true
);

select public.prepare_account_merge(
  repeat('9', 64),
  'account-sync@example.com'
);

reset role;
update private.account_merge_tokens
set
  created_at = clock_timestamp() - interval '11 minutes',
  expires_at = clock_timestamp() - interval '1 minute'
where source_user_id = '99999999-9999-4999-8999-999999999999';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  expired_token_blocked boolean := false;
begin
  begin
    perform public.consume_account_merge(repeat('9', 64));
  exception
    when insufficient_privilege then
      expired_token_blocked := true;
  end;

  if not expired_token_blocked then
    raise exception 'expired merge secret was accepted';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);

-- A transfer must not let two individually valid accounts exceed the target's
-- row quota. The whole attempt rolls back and the same bearer remains usable
-- after the target releases capacity.
insert into auth.users (
  id,
  aud,
  role,
  email,
  encrypted_password,
  raw_app_meta_data,
  raw_user_meta_data,
  is_anonymous,
  email_confirmed_at,
  last_sign_in_at,
  created_at,
  updated_at
)
values
  (
    '88888888-8888-4888-8888-888888888888',
    'authenticated',
    'authenticated',
    null,
    '',
    '{"provider":"anonymous","providers":["anonymous"]}',
    '{}',
    true,
    null,
    now(),
    now(),
    now()
  ),
  (
    '77777777-7777-4777-8777-777777777777',
    'authenticated',
    'authenticated',
    'capacity@example.com',
    '',
    '{"provider":"email","providers":["email"]}',
    '{}',
    false,
    now(),
    now(),
    now(),
    now()
  );

insert into auth.sessions (id, user_id, created_at, updated_at)
values (
  '10000000-0000-4000-8000-000000000081',
  '88888888-8888-4888-8888-888888888888',
  clock_timestamp(),
  clock_timestamp()
);

do $$
declare
  item integer;
begin
  for item in 1..200 loop
    insert into public.tasks (
      id,
      user_id,
      title,
      steps,
      priority,
      estimated_minutes
    )
    values (
      md5('capacity-target-' || item::text)::uuid,
      '77777777-7777-4777-8777-777777777777',
      '容量占位 ' || item::text,
      jsonb_build_array(
        jsonb_build_object(
          'id', 'capacity-' || item::text,
          'title', '占位',
          'completed', false
        )
      ),
      'low',
      5
    );
  end loop;
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
  '66666666-6666-4666-8666-666666666666',
  '88888888-8888-4888-8888-888888888888',
  '容量失败后仍需保留',
  '[{"id":"capacity-source","title":"保留","completed":false}]',
  'low',
  5
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '88888888-8888-4888-8888-888888888888',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '88888888-8888-4888-8888-888888888888',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-000000000081',
    'amr', jsonb_build_array(
      jsonb_build_object(
        'method', 'anonymous',
        'timestamp', floor(extract(epoch from clock_timestamp()))::bigint
      )
    )
  )::text,
  true
);

select public.prepare_account_merge(
  repeat('6', 64),
  'capacity@example.com'
);

reset role;
insert into auth.sessions (id, user_id, created_at, updated_at)
values (
  '10000000-0000-4000-8000-000000000072',
  '77777777-7777-4777-8777-777777777777',
  clock_timestamp(),
  clock_timestamp()
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '77777777-7777-4777-8777-777777777777',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '77777777-7777-4777-8777-777777777777',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-000000000072',
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
  capacity_blocked boolean := false;
begin
  begin
    perform public.consume_account_merge(repeat('6', 64));
  exception
    when program_limit_exceeded then
      capacity_blocked := true;
  end;

  if not capacity_blocked then
    raise exception 'over-capacity account merge was accepted';
  end if;
end;
$$;

reset role;

do $$
begin
  if not exists (
    select 1
    from auth.users
    where id = '88888888-8888-4888-8888-888888888888'
      and is_anonymous is true
  ) or not exists (
    select 1
    from public.tasks
    where id = '66666666-6666-4666-8666-666666666666'
      and user_id = '88888888-8888-4888-8888-888888888888'
  ) or not exists (
    select 1
    from private.account_merge_tokens
    where token_hash = extensions.digest(repeat('6', 64), 'sha256')
      and merge_state = 'prepared'
  ) then
    raise exception 'capacity rejection did not roll back atomically';
  end if;
end;
$$;

delete from public.tasks
where id = md5('capacity-target-200')::uuid;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '77777777-7777-4777-8777-777777777777',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '77777777-7777-4777-8777-777777777777',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-000000000072',
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
begin
  if (public.consume_account_merge(repeat('6', 64))->>'tasks')::bigint <> 1 then
    raise exception 'same merge bearer did not recover after capacity release';
  end if;
end;
$$;

reset role;

do $$
begin
  if exists (
    select 1
    from auth.users
    where id = '88888888-8888-4888-8888-888888888888'
  ) or (
    select count(*)
    from public.tasks
    where user_id = '77777777-7777-4777-8777-777777777777'
  ) <> 200 then
    raise exception 'capacity retry produced an invalid final state';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);

insert into auth.users (
  id,
  aud,
  role,
  email,
  encrypted_password,
  raw_app_meta_data,
  raw_user_meta_data,
  is_anonymous,
  email_confirmed_at,
  last_sign_in_at,
  created_at,
  updated_at
)
values
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'authenticated',
    'authenticated',
    null,
    '',
    '{"provider":"anonymous","providers":["anonymous"]}',
    '{}',
    true,
    null,
    now() - interval '45 days',
    now() - interval '45 days',
    now() - interval '45 days'
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'authenticated',
    'authenticated',
    null,
    '',
    '{"provider":"anonymous","providers":["anonymous"]}',
    '{}',
    true,
    null,
    now() - interval '45 days',
    now() - interval '45 days',
    now() - interval '45 days'
  );

update private.user_activity
set last_active_at = now() - interval '2 days'
where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

insert into auth.users (
  id,
  aud,
  role,
  email,
  encrypted_password,
  raw_app_meta_data,
  raw_user_meta_data,
  is_anonymous,
  last_sign_in_at,
  created_at,
  updated_at
)
select
  md5('cleanup-batch-' || item::text)::uuid,
  'authenticated',
  'authenticated',
  null,
  '',
  '{"provider":"anonymous","providers":["anonymous"]}',
  '{}',
  true,
  now() - interval '45 days',
  now() - interval '45 days',
  now() - interval '45 days'
from generate_series(1, 51) as item;

do $$
declare
  first_batch bigint;
  second_batch bigint;
begin
  first_batch := private.cleanup_expired_anonymous_users();
  second_batch := private.cleanup_expired_anonymous_users();

  if first_batch <> 50 or second_batch <> 2 then
    raise exception 'cleanup batches did not advance 50 then 2: %, %',
      first_batch, second_batch;
  end if;
end;
$$;

do $$
begin
  if exists (
    select 1 from auth.users
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ) then
    raise exception 'inactive anonymous account was not cleaned up';
  end if;

  if not exists (
    select 1 from auth.users
    where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  ) then
    raise exception 'recently active anonymous account was cleaned up';
  end if;

  if exists (
    select 1
    from auth.users
    where id in (
      select md5('cleanup-batch-' || item::text)::uuid
      from generate_series(1, 51) as item
    )
  ) then
    raise exception 'repeated cleanup did not drain the eligible batch';
  end if;

  if (
    select count(*)
    from cron.job
    where jobname = 'studytrace-cleanup-expired-anonymous-users'
      and schedule = '*/15 * * * *'
  ) <> 1 then
    raise exception 'anonymous cleanup cron was not uniquely rescheduled';
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  true
);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-0000000000d1',
    'amr', jsonb_build_array(
      jsonb_build_object(
        'method', 'password',
        'timestamp', floor(extract(epoch from clock_timestamp()))::bigint
      )
    )
  )::text,
  true
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
  '30000000-0000-4000-8000-000000000003',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  '删除账号级联验收',
  '[{"id":"delete-step","title":"删除","completed":false}]',
  'low',
  5
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-0000000000d1',
    'amr', jsonb_build_array(
      jsonb_build_object(
        'method', 'password',
        'timestamp', floor(extract(epoch from clock_timestamp()))::bigint
      )
    )
  )::text,
  true
);

reset role;
update auth.sessions
set not_after = clock_timestamp() - interval '1 second'
where id = '10000000-0000-4000-8000-0000000000d1';

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  stale_session_blocked boolean := false;
begin
  begin
    perform public.prepare_account_deletion(repeat('d', 64));
  exception
    when insufficient_privilege then
      stale_session_blocked := true;
  end;

  if not stale_session_blocked then
    raise exception 'an expired auth session prepared a deletion bearer';
  end if;
end;
$$;

reset role;
update auth.sessions
set not_after = null
where id = '10000000-0000-4000-8000-0000000000d1';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);

select public.prepare_account_deletion(repeat('d', 64));

do $$
declare
  refresh_after_cancel_blocked boolean := false;
begin
  if not public.cancel_account_deletion(repeat('d', 64)) then
    raise exception 'deletion cancellation did not revoke its token';
  end if;

  if not public.cancel_account_deletion(repeat('d', 64)) then
    raise exception 'absent deletion cancellation was not idempotently accepted';
  end if;

  begin
    perform public.refresh_account_deletion(repeat('d', 64));
  exception
    when insufficient_privilege then
      refresh_after_cancel_blocked := true;
  end;

  if not refresh_after_cancel_blocked then
    raise exception 'cancelled deletion token could still be refreshed';
  end if;
end;
$$;

-- The unique per-user slot is immediately reusable after explicit cancel.
select public.prepare_account_deletion(repeat('d', 64));

do $$
declare
  initiating_session_blocked boolean := false;
  wrong_secret_blocked boolean := false;
begin
  begin
    perform public.delete_my_account(repeat('d', 64));
  exception
    when insufficient_privilege then
      initiating_session_blocked := true;
  end;

  begin
    perform public.delete_my_account(repeat('8', 64));
  exception
    when insufficient_privilege then
      wrong_secret_blocked := true;
  end;

  if not initiating_session_blocked then
    raise exception 'the initiating session bypassed deletion OTP verification';
  end if;
  if not wrong_secret_blocked then
    raise exception 'an incorrect deletion bearer was accepted';
  end if;
end;
$$;

reset role;
insert into auth.sessions (id, user_id, created_at, updated_at)
values (
  '10000000-0000-4000-8000-0000000000d2',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  clock_timestamp(),
  clock_timestamp()
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-0000000000d2',
    'amr', jsonb_build_array(
      jsonb_build_object(
        'method', 'password',
        'timestamp', floor(extract(epoch from clock_timestamp()))::bigint
      )
    )
  )::text,
  true
);

do $$
declare
  password_amr_blocked boolean := false;
begin
  begin
    perform public.delete_my_account(repeat('d', 64));
  exception
    when insufficient_privilege then
      password_amr_blocked := true;
  end;

  if not password_amr_blocked then
    raise exception 'new password session bypassed deletion email OTP';
  end if;
end;
$$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-0000000000d2',
    'amr', jsonb_build_array(
      jsonb_build_object('method', 'otp', 'timestamp', 0)
    )
  )::text,
  true
);

do $$
declare
  stale_otp_blocked boolean := false;
begin
  begin
    perform public.delete_my_account(repeat('d', 64));
  exception
    when insufficient_privilege then
      stale_otp_blocked := true;
  end;

  if not stale_otp_blocked then
    raise exception 'stale OTP bypassed deletion freshness check';
  end if;
end;
$$;

reset role;
update auth.users
set
  raw_app_meta_data =
    '{"provider":"email","providers":["email","phone"]}',
  phone = '+15555550124',
  phone_confirmed_at = clock_timestamp()
where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-0000000000d2',
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
  phone_provider_blocked boolean := false;
begin
  begin
    perform public.delete_my_account(repeat('d', 64));
  exception
    when insufficient_privilege then
      phone_provider_blocked := true;
  end;

  if not phone_provider_blocked then
    raise exception 'multi-provider phone OTP was accepted for deletion';
  end if;
end;
$$;

reset role;
update auth.users
set
  raw_app_meta_data = '{"provider":"email","providers":["email"]}',
  phone = null,
  phone_confirmed_at = null
where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-0000000000d2',
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
begin
  if not public.cancel_account_deletion(repeat('d', 64)) then
    raise exception 'fresh replacement session could not cancel deletion';
  end if;
end;
$$;

-- Reprepare from d2, then require a still newer OTP session d3 to delete.
select public.prepare_account_deletion(repeat('d', 64));

reset role;
insert into auth.sessions (id, user_id, created_at, updated_at)
values (
  '10000000-0000-4000-8000-0000000000d3',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  clock_timestamp(),
  clock_timestamp()
);
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'role', 'authenticated',
    'session_id', '10000000-0000-4000-8000-0000000000d3',
    'amr', jsonb_build_array(
      jsonb_build_object(
        'method', 'otp',
        'timestamp', floor(extract(epoch from clock_timestamp()))::bigint
      )
    )
  )::text,
  true
);

select public.delete_my_account(repeat('d', 64));

reset role;
do $$
begin
  if exists (
    select 1 from auth.users
    where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  ) then
    raise exception 'OTP-confirmed permanent account was not deleted';
  end if;

  if exists (
    select 1 from public.tasks
    where id = '30000000-0000-4000-8000-000000000003'
  ) then
    raise exception 'deleted account business records did not cascade';
  end if;

  if not exists (
    select 1 from auth.users
    where id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  ) then
    raise exception 'account deletion affected another user';
  end if;
end;
$$;

rollback;
