-- Isolated database only. Fixtures and quota writes are rolled back.
begin;

do $$
begin
  if has_table_privilege('anon','public.ai_reports','select')
    or has_table_privilege('authenticated','public.ai_reports','insert,update,delete')
    or has_function_privilege('authenticated','public.claim_learning_report(uuid,integer,text)','execute')
    or has_function_privilege('anon','public.finish_learning_report(uuid,uuid,jsonb,text,jsonb,text)','execute')
    or has_function_privilege('authenticated','public.list_due_learning_report_users(integer,uuid[])','execute')
    or has_function_privilege('authenticated','private.build_learning_report_snapshot(uuid,integer)','execute')
    or has_table_privilege('authenticated','private.ai_report_jobs','select') then
    raise exception 'report service privileges exposed';
  end if;
end; $$;

insert into auth.users(id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,is_anonymous,email_confirmed_at,created_at,updated_at)
values
('a1000000-0000-4000-8000-000000000001','authenticated','authenticated','report-owner@example.test','','{"provider":"email"}','{}',false,now(),now(),now()),
('a1000000-0000-4000-8000-000000000002','authenticated','authenticated',null,'','{"provider":"anonymous"}','{}',true,null,now(),now());
insert into public.user_settings(user_id) values
('a1000000-0000-4000-8000-000000000001'),('a1000000-0000-4000-8000-000000000002');
insert into public.user_consents(user_id,feature,version,granted,granted_at) values
('a1000000-0000-4000-8000-000000000001','ai_reports','2026-11-08.v1',true,now()),
('a1000000-0000-4000-8000-000000000001','weekly_reports','2026-11-08.v1',true,now()-interval '8 days'),
('a1000000-0000-4000-8000-000000000002','ai_reports','2026-11-08.v1',true,now());

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('request.jwt.claim.role','service_role',true);
do $$
declare first_claim jsonb; duplicate_claim jsonb; completed boolean; cached jsonb;
begin
  first_claim:=public.claim_learning_report('a1000000-0000-4000-8000-000000000001',7,'manual');
  if first_claim->>'state'<>'claimed' then raise exception 'report was not claimed: %',first_claim; end if;
  duplicate_claim:=public.claim_learning_report('a1000000-0000-4000-8000-000000000001',7,'manual');
  if duplicate_claim->>'state'<>'pending' or duplicate_claim->>'report_id'<>first_claim->>'report_id' then
    raise exception 'duplicate request created another job';
  end if;
  completed:=public.finish_learning_report((first_claim->>'report_id')::uuid,gen_random_uuid(),'{}','test-model','{}');
  if completed then raise exception 'wrong lease was accepted'; end if;
  completed:=public.finish_learning_report((first_claim->>'report_id')::uuid,(first_claim->>'lease_token')::uuid,'{"title":"Fixture only"}','test-model','{"total_tokens":12}');
  if not completed then raise exception 'correct lease was rejected'; end if;
  if public.finish_learning_report((first_claim->>'report_id')::uuid,(first_claim->>'lease_token')::uuid,'{}','test-model','{}') then
    raise exception 'same completed lease was used twice';
  end if;
  cached:=public.claim_learning_report('a1000000-0000-4000-8000-000000000001',7,'manual');
  if cached->>'state'<>'cached' or cached->>'report_id'<>first_claim->>'report_id' then raise exception 'unchanged snapshot was not reused'; end if;
  if (public.claim_learning_report('a1000000-0000-4000-8000-000000000001',7,'weekly')->>'state')<>'no_new_records' then
    raise exception 'empty weekly period was generated';
  end if;
  begin
    perform public.claim_learning_report('a1000000-0000-4000-8000-000000000002',7,'weekly');
    raise exception 'anonymous weekly report accepted';
  exception when insufficient_privilege then null; end;
end; $$;
reset role;

-- A valid anonymous user can request manual reports. Revoking consent while a
-- provider request is in flight prevents the result from being stored.
set local role service_role;
do $$
declare job jsonb;
begin
  job:=public.claim_learning_report('a1000000-0000-4000-8000-000000000002',30,'manual');
  perform set_config('test.report_id',job->>'report_id',true);
  perform set_config('test.report_lease',job->>'lease_token',true);
end; $$;
reset role;
update public.user_consents set granted=false,revoked_at=now() where user_id='a1000000-0000-4000-8000-000000000002';
set local role service_role;
do $$
begin
  if public.finish_learning_report(current_setting('test.report_id')::uuid,current_setting('test.report_lease')::uuid,'{}','test-model','{}') then
    raise exception 'revoked report consent was ignored';
  end if;
end; $$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','a1000000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
do $$
begin
  if exists(select 1 from public.ai_reports) then raise exception 'another owner report leaked'; end if;
  if jsonb_array_length(public.export_my_learning_records('ai_reports','a1000000-0000-4000-8000-000000000002',0))<>0 then raise exception 'export leaked another owner'; end if;
  begin
    perform public.export_my_learning_records('auth.users','a1000000-0000-4000-8000-000000000002',0);
    raise exception 'arbitrary table export accepted';
  exception when invalid_parameter_value then null; end;
end; $$;
reset role;

delete from public.user_settings where user_id='a1000000-0000-4000-8000-000000000001';
do $$
begin
  if exists(select 1 from public.ai_reports where user_id='a1000000-0000-4000-8000-000000000001')
    or exists(select 1 from private.ai_report_jobs)
    or exists(select 1 from public.user_consents where user_id='a1000000-0000-4000-8000-000000000001') then
    raise exception 'data reset left report data or consent behind';
  end if;
end; $$;
rollback;
