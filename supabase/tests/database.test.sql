-- StudyTrace database acceptance tests.
-- Run against an isolated/local database or through a single transaction.
-- Every row created here is rolled back at the end.

begin;

do $$
begin
  if has_table_privilege('anon', 'public.tasks', 'select') then
    raise exception 'anon must not have SELECT on public.tasks';
  end if;

  if not has_table_privilege('authenticated', 'public.tasks', 'select,insert,update,delete') then
    raise exception 'authenticated must have task CRUD privileges';
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
  '[{"id":"step-a","title":"第一步","completed":false}]',
  'medium',
  25
);

insert into public.study_sessions (
  id,
  user_id,
  task_id,
  status
)
values (
  '20000000-0000-4000-8000-000000000001',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '10000000-0000-4000-8000-000000000001',
  'running'
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

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

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
  estimated_minutes,
  status
)
values (
  '10000000-0000-4000-8000-000000000003',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '级联删除任务',
  '[{"id":"step-c","title":"第一步","completed":true}]',
  'high',
  20,
  'completed'
);

insert into public.study_sessions (
  id,
  user_id,
  task_id,
  status,
  accumulated_seconds,
  ended_at
)
values (
  '20000000-0000-4000-8000-000000000003',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '10000000-0000-4000-8000-000000000003',
  'completed',
  600,
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

select 'StudyTrace database acceptance tests passed' as result;

rollback;
