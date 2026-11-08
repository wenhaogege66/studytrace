-- Isolated local password-account boundaries. Every fixture is rolled back.
begin;

do $$
begin
  if has_function_privilege('anon', 'public.delete_my_password_account()', 'execute')
    or not has_function_privilege('authenticated', 'public.delete_my_password_account()', 'execute')
  then raise exception 'incorrect password deletion grants'; end if;
  if has_schema_privilege('authenticated', 'private', 'usage') then
    raise exception 'private schema exposed';
  end if;
end;
$$;

insert into auth.users(id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at)
values
  ('a1100000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', null, '', '{"provider":"anonymous"}', '{}', true, now(), now()),
  ('a1100000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'password-test@example.com', 'not-a-real-hash-fixture', '{"provider":"email"}', '{}', false, now(), now()),
  ('a1100000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'other-test@example.com', 'not-a-real-hash-fixture', '{"provider":"email"}', '{}', false, now(), now());
insert into auth.sessions(id, user_id, created_at, updated_at)
values
  ('a2200000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000001', now(), now()),
  ('a2200000-0000-4000-8000-000000000002', 'a1100000-0000-4000-8000-000000000002', now(), now()),
  ('a2200000-0000-4000-8000-000000000003', 'a1100000-0000-4000-8000-000000000003', now(), now()),
  ('a2200000-0000-4000-8000-000000000004', 'a1100000-0000-4000-8000-000000000002', now() - interval '6 minutes', now());
insert into public.tasks(id, user_id, title, estimated_minutes, steps, priority, status)
values
  ('a3300000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000002', 'Caller only', 25, '[{"id":"one","title":"Step","completed":false}]', 'medium', 'planned'),
  ('a3300000-0000-4000-8000-000000000002', 'a1100000-0000-4000-8000-000000000003', 'Other owner', 25, '[{"id":"one","title":"Step","completed":false}]', 'medium', 'planned');

create function pg_temp.assert_password_deletion_rejected()
returns void language plpgsql as $$
begin
  perform public.delete_my_password_account();
  raise exception 'deletion unexpectedly succeeded';
exception when insufficient_privilege then null;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'a1100000-0000-4000-8000-000000000002',
  'session_id', 'a2200000-0000-4000-8000-000000000002',
  'amr', jsonb_build_array(jsonb_build_object('method', 'otp', 'timestamp', extract(epoch from now())))
)::text, true);
select pg_temp.assert_password_deletion_rejected();

-- Refreshing an old token does not make password verification fresh.
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'a1100000-0000-4000-8000-000000000002',
  'session_id', 'a2200000-0000-4000-8000-000000000002',
  'amr', jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now() - interval '6 minutes')))
)::text, true);
select pg_temp.assert_password_deletion_rejected();

-- Fresh AMR cannot stand in for an old, missing or other-owner Auth session.
do $$
declare fixture text;
begin
  foreach fixture in array array[
    'a2200000-0000-4000-8000-000000000004',
    'a2200000-0000-4000-8000-000000000099',
    'a2200000-0000-4000-8000-000000000003'
  ] loop
    perform set_config('request.jwt.claims', jsonb_build_object(
      'sub', 'a1100000-0000-4000-8000-000000000002',
      'session_id', fixture,
      'amr', jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now())))
    )::text, true);
    perform pg_temp.assert_password_deletion_rejected();
  end loop;
end;
$$;

select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'a1100000-0000-4000-8000-000000000001',
  'session_id', 'a2200000-0000-4000-8000-000000000001',
  'amr', jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now())))
)::text, true);
select pg_temp.assert_password_deletion_rejected();

select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'a1100000-0000-4000-8000-000000000002',
  'session_id', 'a2200000-0000-4000-8000-000000000002',
  'amr', jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now())))
)::text, true);
select public.delete_my_password_account();
reset role;

do $$
begin
  if exists(select 1 from auth.users where id = 'a1100000-0000-4000-8000-000000000002')
    or exists(select 1 from public.tasks where user_id = 'a1100000-0000-4000-8000-000000000002')
    or exists(select 1 from auth.sessions where user_id = 'a1100000-0000-4000-8000-000000000002')
  then raise exception 'caller deletion did not cascade'; end if;
  if not exists(select 1 from auth.users where id = 'a1100000-0000-4000-8000-000000000003')
    or not exists(select 1 from public.tasks where user_id = 'a1100000-0000-4000-8000-000000000003')
  then raise exception 'other user was changed'; end if;
end;
$$;
rollback;
