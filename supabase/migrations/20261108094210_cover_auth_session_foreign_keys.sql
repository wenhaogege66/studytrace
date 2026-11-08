-- Cover owner/version and Auth-session cascades. The retired token tables stay
-- private until a future compatibility removal, so cleanup still needs indexes.
create index account_delete_tokens_source_session_idx on private.account_delete_tokens(source_session_id);
create index account_merge_tokens_source_session_idx on private.account_merge_tokens(source_session_id);
create index account_merge_tokens_target_session_idx on private.account_merge_tokens(target_session_id);
create index study_sessions_plan_revision_owner_idx on public.study_sessions(plan_revision_id,task_id,user_id);
create index tasks_adopted_revision_owner_idx on public.tasks(current_plan_revision_id,id,user_id);
