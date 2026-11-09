-- Run only against an isolated/local StudyTrace database after all migrations.
-- No provider calls. Every fixture, quota write and job transition rolls back.
begin;

insert into auth.users (
  id, aud, role, email, encrypted_password, raw_app_meta_data,
  raw_user_meta_data, is_anonymous, email_confirmed_at, created_at, updated_at
) values
  ('a2000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'report-cycle-adversarial@example.test', '', '{"provider":"email"}', '{}', false, now(), now(), now()),
  ('a2000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
   'report-lease-adversarial@example.test', '', '{"provider":"email"}', '{}', false, now(), now(), now()),
  ('a2000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
   'report-quota-adversarial@example.test', '', '{"provider":"email"}', '{}', false, now(), now(), now());

insert into public.user_settings (user_id) values
  ('a2000000-0000-4000-8000-000000000001'),
  ('a2000000-0000-4000-8000-000000000002'),
  ('a2000000-0000-4000-8000-000000000003');

insert into public.user_consents (user_id, feature, version, granted, granted_at) values
  ('a2000000-0000-4000-8000-000000000001', 'ai_reports', '2026-11-08.v1', true, now()),
  ('a2000000-0000-4000-8000-000000000001', 'weekly_reports', '2026-11-08.v1', true, now() - interval '8 days'),
  ('a2000000-0000-4000-8000-000000000002', 'ai_reports', '2026-11-08.v1', true, now()),
  ('a2000000-0000-4000-8000-000000000002', 'weekly_reports', '2026-11-08.v1', true, now() - interval '8 days'),
  ('a2000000-0000-4000-8000-000000000003', 'ai_reports', '2026-11-08.v1', true, now());

select set_config('test.adversarial.plan', '{
  "title":"函数复习", "intent":"复习五道函数错题", "purpose":"为测验准备",
  "purposeOptions":["为测验准备"], "context":{}, "method":"EXECUTED_ADOPTED_METHOD",
  "methodReason":"检验实际掌握情况", "completionCriteria":["独立重做五题","解释错误原因","完成一次自测"],
  "selectedCriterion":"独立重做五题", "steps":[
    {"id":"s1","title":"整理错题","completed":false},
    {"id":"s2","title":"重做五题","completed":false},
    {"id":"s3","title":"检查原因","completed":false}],
  "priority":"medium", "estimatedMinutes":60, "sessionMinutes":25,
  "observationProfile":"study_paper_v1", "observationAgreement":{
    "phone":"allowed","tablet":"restricted","absenceSeconds":120,"screenDirection":false},
  "dueAt":null
}', true);

-- Create a genuine execution on revision A, then adopt (but do not execute)
-- revision B. AI-only recommendations and another never-started plan are noise.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a2000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000001","role":"authenticated","is_anonymous":false}', true);
do $$
declare
  plan jsonb := current_setting('test.adversarial.plan')::jsonb;
  created public.tasks;
  revised public.tasks;
  learning public.study_sessions;
begin
  created := public.save_learning_plan(gen_random_uuid(), null, null, plan,
    jsonb_build_array(jsonb_build_object('kind', 'ai_initial', 'snapshot',
      jsonb_set(plan, '{method}', '"AI_INITIAL_NOT_ADOPTED"'::jsonb), 'changes', '[]'::jsonb)));
  learning := public.start_study_session(created.id, true, false);
  if learning.plan_revision_id is distinct from created.current_plan_revision_id then
    raise exception 'Fixture did not snapshot the executed revision';
  end if;
  perform public.cancel_study_session(learning.id, 0);
  perform set_config('test.adversarial.executed_revision', created.current_plan_revision_id::text, true);
  plan := jsonb_set(plan, '{method}', '"LATEST_UNEXECUTED_CURRENT_METHOD"'::jsonb);
  revised := public.save_learning_plan(gen_random_uuid(), created.id, created.current_plan_revision_id, plan,
    jsonb_build_array(jsonb_build_object('kind', 'ai_review', 'snapshot',
      jsonb_set(plan, '{method}', '"AI_REVIEW_NOT_ADOPTED"'::jsonb), 'changes', '[]'::jsonb)));
  perform set_config('test.adversarial.plan_id', revised.id::text, true);
  perform public.save_learning_plan(gen_random_uuid(), null, null,
    jsonb_set(plan, '{method}', '"NEVER_EXECUTED_OTHER_PLAN"'::jsonb), '[]'::jsonb);
end; $$;
reset role;

do $$
declare snapshot jsonb;
begin
  snapshot := private.build_learning_report_snapshot('a2000000-0000-4000-8000-000000000001', 7);
  if jsonb_array_length(snapshot->'adopted_plans') <> 1
    or snapshot->'adopted_plans'->0->>'method' <> 'EXECUTED_ADOPTED_METHOD' then
    raise exception 'Report did not use the actual executed plan revision: %', snapshot->'adopted_plans';
  end if;
  if snapshot::text like '%LATEST_UNEXECUTED_CURRENT_METHOD%'
    or snapshot::text like '%NEVER_EXECUTED_OTHER_PLAN%'
    or snapshot::text like '%AI_INITIAL_NOT_ADOPTED%'
    or snapshot::text like '%AI_REVIEW_NOT_ADOPTED%' then
    raise exception 'Unexecuted current method or AI-only recommendation entered the snapshot';
  end if;
  if exists(select 1 from jsonb_array_elements(snapshot->'adjustments') item where item->>'kind' <> 'adopted') then
    raise exception 'Unadopted revision entered the report adjustment evidence';
  end if;
end; $$;

-- Hold one weekly job, create genuinely new execution data, and claim again.
-- A changed input hash must not create a second job within the same cycle.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare job jsonb;
begin
  job := public.claim_learning_report('a2000000-0000-4000-8000-000000000001', 7, 'weekly');
  if job->>'state' <> 'claimed' then raise exception 'Weekly cycle was not claimed: %', job; end if;
  perform set_config('test.adversarial.cycle_report', job->>'report_id', true);
  perform set_config('test.adversarial.cycle_lease', job->>'lease_token', true);
end; $$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000001","role":"authenticated","is_anonymous":false}', true);
do $$
declare learning public.study_sessions;
begin
  learning := public.start_study_session(current_setting('test.adversarial.plan_id')::uuid, true, false);
  perform public.cancel_study_session(learning.id, 0);
end; $$;
reset role;

do $$
declare original jsonb; changed jsonb;
begin
  select input_snapshot into original from public.ai_reports where id = current_setting('test.adversarial.cycle_report')::uuid;
  changed := private.build_learning_report_snapshot('a2000000-0000-4000-8000-000000000001', 7);
  if (original #- '{facts,generated_at}') = (changed #- '{facts,generated_at}') then
    raise exception 'Fixture did not change the report input while the first cycle was in flight';
  end if;
end; $$;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare duplicate jsonb;
begin
  duplicate := public.claim_learning_report('a2000000-0000-4000-8000-000000000001', 7, 'weekly');
  if duplicate->>'state' <> 'pending'
    or duplicate->>'report_id' <> current_setting('test.adversarial.cycle_report') then
    raise exception 'Changed data created a second weekly job: %', duplicate;
  end if;
  if not public.finish_learning_report(current_setting('test.adversarial.cycle_report')::uuid,
    current_setting('test.adversarial.cycle_lease')::uuid, '{"title":"Cycle fixture only"}', 'test-model', '{}') then
    raise exception 'Original weekly lease could not complete';
  end if;
  if public.claim_learning_report('a2000000-0000-4000-8000-000000000001', 7, 'weekly')->>'state' <> 'not_due' then
    raise exception 'Successful cycle was scheduled again immediately';
  end if;
end; $$;
reset role;

do $$
declare due timestamptz; snapshot jsonb;
begin
  select cycle_due_at, input_snapshot into due, snapshot from public.ai_reports
    where id = current_setting('test.adversarial.cycle_report')::uuid;
  if due is null or (select count(*) from public.ai_reports
    where user_id = 'a2000000-0000-4000-8000-000000000001' and cycle_due_at = due) <> 1 then
    raise exception 'Weekly cycle does not have exactly one report';
  end if;
  begin
    insert into public.ai_reports(user_id, period_days, source, cycle_due_at, input_hash, input_snapshot)
      values('a2000000-0000-4000-8000-000000000001', 7, 'weekly', due, repeat('c',64), snapshot);
    raise exception 'Database allowed a second report for the same owner and weekly cycle';
  exception when unique_violation then null; end;
end; $$;

-- A separate weekly owner exercises all three leases without the two-per-day
-- manual quota interfering. No wall-clock sleep is needed: only test leases
-- are expired directly by the local administrative fixture.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a2000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000002","role":"authenticated","is_anonymous":false}', true);
do $$
declare created public.tasks; learning public.study_sessions;
begin
  created := public.save_learning_plan(gen_random_uuid(), null, null,
    current_setting('test.adversarial.plan')::jsonb, '[]'::jsonb);
  learning := public.start_study_session(created.id, true, false);
  perform public.cancel_study_session(learning.id, 0);
end; $$;
reset role;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare job jsonb;
begin
  job := public.claim_learning_report('a2000000-0000-4000-8000-000000000002', 7, 'weekly');
  if job->>'state' <> 'claimed' then raise exception 'Lease fixture was not claimed'; end if;
  perform set_config('test.adversarial.lease_report', job->>'report_id', true);
  perform set_config('test.adversarial.first_lease', job->>'lease_token', true);
end; $$;
reset role;

update private.ai_report_jobs set lease_expires_at = clock_timestamp() - interval '1 second'
  where report_id = current_setting('test.adversarial.lease_report')::uuid;

set local role service_role;
do $$
declare retried jsonb;
begin
  if public.finish_learning_report(current_setting('test.adversarial.lease_report')::uuid,
    current_setting('test.adversarial.first_lease')::uuid, '{}', 'test-model', '{}') then
    raise exception 'Expired lease was allowed to save a report';
  end if;
  retried := public.claim_learning_report('a2000000-0000-4000-8000-000000000002', 7, 'weekly');
  if retried->>'state' <> 'claimed' or retried->>'report_id' <> current_setting('test.adversarial.lease_report')
    or retried->>'lease_token' = current_setting('test.adversarial.first_lease') then
    raise exception 'Expired cycle did not reuse its report with a fresh lease';
  end if;
  if public.finish_learning_report(current_setting('test.adversarial.lease_report')::uuid,
    current_setting('test.adversarial.first_lease')::uuid, '{}', 'test-model', '{}') then
    raise exception 'Replaced old lease was allowed to save a report';
  end if;
end; $$;
reset role;

update private.ai_report_jobs set lease_expires_at = clock_timestamp() - interval '1 second'
  where report_id = current_setting('test.adversarial.lease_report')::uuid;
set local role service_role;
do $$
declare retried jsonb;
begin
  retried := public.claim_learning_report('a2000000-0000-4000-8000-000000000002', 7, 'weekly');
  if retried->>'state' <> 'claimed' or retried->>'report_id' <> current_setting('test.adversarial.lease_report') then
    raise exception 'Third and final lease was not issued on the same cycle';
  end if;
end; $$;
reset role;
update private.ai_report_jobs set lease_expires_at = clock_timestamp() - interval '1 second'
  where report_id = current_setting('test.adversarial.lease_report')::uuid;
set local role service_role;
do $$
begin
  if public.claim_learning_report('a2000000-0000-4000-8000-000000000002', 7, 'weekly')->>'state' <> 'retry_limit' then
    raise exception 'A fourth lease exceeded the bounded retry limit';
  end if;
end; $$;
reset role;
do $$
begin
  if (select attempts from private.ai_report_jobs where report_id = current_setting('test.adversarial.lease_report')::uuid) <> 3
    or (select status from public.ai_reports where id = current_setting('test.adversarial.lease_report')::uuid) <> 'failed'
    or (select next_due_at from private.ai_report_schedule where user_id = 'a2000000-0000-4000-8000-000000000002') <= clock_timestamp() then
    raise exception 'Retry exhaustion left an active lease or a starving due cycle';
  end if;
end; $$;

-- Spend both manual allowances using distinct 7/30-day snapshots. A learning
-- data reset must remove reports/consents without granting two new API calls.
set local role service_role;
do $$
declare days integer; job jsonb;
begin
  foreach days in array array[7,30] loop
    job := public.claim_learning_report('a2000000-0000-4000-8000-000000000003', days, 'manual');
    if job->>'state' <> 'claimed' then raise exception 'Manual quota fixture was not claimed: %', job; end if;
    if not public.finish_learning_report((job->>'report_id')::uuid, (job->>'lease_token')::uuid,
      '{"title":"Quota fixture only"}', 'test-model', '{}') then raise exception 'Manual quota fixture did not finish'; end if;
  end loop;
end; $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a2000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000003","role":"authenticated","is_anonymous":false}', true);
select public.delete_my_data();
reset role;

do $$
begin
  if (select requests from private.ai_report_budget
    where scope = 'user:a2000000-0000-4000-8000-000000000003'
      and day = (clock_timestamp() at time zone 'UTC')::date) is distinct from 2 then
    raise exception 'Clearing learning records reset the daily report quota';
  end if;
  if exists(select 1 from public.ai_reports where user_id = 'a2000000-0000-4000-8000-000000000003')
    or exists(select 1 from public.user_consents where user_id = 'a2000000-0000-4000-8000-000000000003') then
    raise exception 'Learning data reset did not remove report data and consent';
  end if;
end; $$;
insert into public.user_settings(user_id) values('a2000000-0000-4000-8000-000000000003');
insert into public.user_consents(user_id,feature,version,granted,granted_at)
  values('a2000000-0000-4000-8000-000000000003','ai_reports','2026-11-08.v1',true,now());
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
begin
  if public.claim_learning_report('a2000000-0000-4000-8000-000000000003', 7, 'manual')->>'state' <> 'quota' then
    raise exception 'Recreating settings and consent bypassed the daily report quota';
  end if;
end; $$;
reset role;

-- A stale export page must reject an identity switch, rather than silently
-- exporting the newly signed-in user's records under the old UI identity.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a2000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000001","role":"authenticated","is_anonymous":false}', true);
do $$
declare own_rows jsonb;
begin
  own_rows := public.export_my_learning_records('tasks','a2000000-0000-4000-8000-000000000001',0);
  if jsonb_array_length(own_rows) = 0 or exists(select 1 from jsonb_array_elements(own_rows) item
    where item->>'user_id' <> 'a2000000-0000-4000-8000-000000000001') then
    raise exception 'Owner export was empty or contained another identity';
  end if;
  begin
    perform public.export_my_learning_records('tasks','a2000000-0000-4000-8000-000000000002',0);
    raise exception 'Export accepted a mismatched expected owner';
  exception when insufficient_privilege then null; end;
  begin
    perform public.export_my_learning_records('tasks',null,0);
    raise exception 'Export accepted an omitted expected owner';
  exception when insufficient_privilege then null; end;
end; $$;
reset role;

rollback;
