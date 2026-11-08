-- Transactional owner isolation, revision atomicity and session snapshot checks.
begin;
insert into auth.users(id,aud,role,is_anonymous,raw_app_meta_data,raw_user_meta_data,created_at)
values ('83000000-0000-4000-8000-000000000001','authenticated','authenticated',true,'{"provider":"anonymous","providers":["anonymous"]}','{}',now()),
       ('83000000-0000-4000-8000-000000000002','authenticated','authenticated',true,'{"provider":"anonymous","providers":["anonymous"]}','{}',now());

set local role authenticated;
select set_config('request.jwt.claim.sub','83000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"83000000-0000-4000-8000-000000000001","role":"authenticated","is_anonymous":true}',true);
do $$
declare
  plan jsonb := '{"title":"函数复习","intent":"复习五道函数错题","purpose":"为测验准备","purposeOptions":["为测验准备"],"context":{},"method":"独立重做后检查原因","methodReason":"检验实际掌握情况","completionCriteria":["独立重做五题","解释错误原因","完成一次自测"],"selectedCriterion":"独立重做五题","steps":[{"id":"s1","title":"整理错题","completed":false},{"id":"s2","title":"重做五题","completed":false},{"id":"s3","title":"检查原因","completed":false}],"priority":"medium","estimatedMinutes":60,"sessionMinutes":25,"observationProfile":"study_paper_v1","observationAgreement":{"phone":"allowed","tablet":"restricted","absenceSeconds":120,"screenDirection":false},"dueAt":null}';
  request_id uuid := '83000000-0000-4000-8000-000000000011';
  created public.tasks; repeated public.tasks; updated public.tasks;
  active public.study_sessions; original_revision uuid;
begin
  created := public.save_learning_plan(request_id,null,null,plan,'[]');
  original_revision := created.current_plan_revision_id;
  if original_revision is null then raise exception 'Missing adopted revision'; end if;
  repeated := public.save_learning_plan(request_id,null,null,plan,'[]');
  if repeated.id <> created.id or (select count(*) from public.task_plan_revisions where task_id = created.id) <> 1 then
    raise exception 'Idempotent retry duplicated a plan or revision'; end if;
  begin
    perform public.save_learning_plan(request_id,null,null,jsonb_set(plan,'{title}','"另一个计划"'),'[]');
    raise exception 'Expected idempotency conflict';
  exception when unique_violation then null; end;
  begin
    update public.task_plan_revisions set snapshot = '{}' where task_id = created.id;
    raise exception 'Revision history must be immutable to the user';
  exception when insufficient_privilege then null; end;
  active := public.start_study_session(created.id,true,false);
  if active.plan_revision_id <> original_revision or active.observation_agreement <> plan->'observationAgreement' or active.target_minutes <> 25 then
    raise exception 'Session snapshot does not match adopted plan'; end if;
  active := public.update_session_learning_context(active.id,20,'steady');
  if active.target_minutes <> 20 or active.energy_before <> 'steady' then raise exception 'Learning context did not save'; end if;
  begin
    perform public.save_learning_plan(gen_random_uuid(),created.id,original_revision,plan,'[]');
    raise exception 'Expected active session structural lock';
  exception when check_violation then null; end;
  perform public.cancel_study_session(active.id,0);
  created := public.set_task_step_completed(created.id,'s1',true);
  plan := jsonb_set(plan,'{steps}',created.steps);
  updated := public.save_learning_plan(gen_random_uuid(),created.id,original_revision,plan,'[]');
  if not (updated.steps->0->>'completed')::boolean then raise exception 'Completed progress was lost'; end if;
  begin
    perform public.save_learning_plan(gen_random_uuid(),created.id,original_revision,plan,'[]');
    raise exception 'Expected stale revision conflict';
  exception when serialization_failure then null; end;
  begin
    perform public.save_learning_plan(gen_random_uuid(),created.id,updated.current_plan_revision_id,jsonb_set(plan,'{steps,0,title}','"改写已完成步骤"'),'[]');
    raise exception 'Expected completed step preservation';
  exception when check_violation then null; end;
  begin
    update public.tasks set method_summary = '绕过版本写入' where id = created.id;
    raise exception 'Expected versioned metadata guard';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub','83000000-0000-4000-8000-000000000002',true);
  if exists(select 1 from public.task_plan_revisions where task_id = created.id) then raise exception 'Revision RLS leak'; end if;
  begin
    perform public.save_learning_plan(gen_random_uuid(),created.id,updated.current_plan_revision_id,plan,'[]');
    raise exception 'Expected cross-owner write rejection';
  exception when insufficient_privilege then null; end;
  begin
    perform public.update_session_learning_context(active.id,20,'low');
    raise exception 'Expected cross-owner context rejection';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
