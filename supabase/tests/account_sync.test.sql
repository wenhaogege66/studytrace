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
    'public.prepare_account_deletion(text)',
    'public.refresh_account_deletion(text)',
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
select public.prepare_account_merge(
  repeat('a', 64),
  'account-sync@example.com'
);

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

select public.refresh_account_merge(repeat('a', 64));

reset role;
insert into auth.sessions (id, user_id, created_at, updated_at)
values (
  '10000000-0000-4000-8000-0000000000f2',
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
  merge_result jsonb;
  second_consume_blocked boolean := false;
begin
  merge_result := public.consume_account_merge(repeat('a', 64));
  if (merge_result->>'tasks')::bigint <> 1
    or (merge_result->>'sessions')::bigint <> 1
    or (merge_result->>'behavior_events')::bigint <> 1
    or (merge_result->>'reminder_events')::bigint <> 1
    or (merge_result->>'reviews')::bigint <> 1
  then
    raise exception 'merge result counts were incorrect: %', merge_result;
  end if;

  begin
    perform public.consume_account_merge(repeat('a', 64));
  exception
    when insufficient_privilege or no_data_found then
      second_consume_blocked := true;
  end;

  if not second_consume_blocked then
    raise exception 'merge secret was reusable';
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
end;
$$;

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

insert into private.user_activity (user_id, last_active_at)
values (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  now() - interval '2 days'
);

select private.cleanup_expired_anonymous_users();

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
