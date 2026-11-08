-- Harden the factual-insights foundation after the security/data-correctness
-- review. This migration intentionally contains the small PR3 integration
-- surface (merge ownership hooks) so it can be rebased independently.

create or replace function private.insight_effective_end(
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_last_confirmed_at timestamptz,
  p_report_generated_at timestamptz
)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select greatest(
    p_started_at,
    least(
      coalesce(p_ended_at, p_last_confirmed_at, p_started_at),
      p_report_generated_at
    )
  );
$$;

revoke all on function private.insight_effective_end(
  timestamptz, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated;

-- A wall-clock state transition is evidence only while it stays close to the
-- last server-confirmed activity. If the browser vanished for longer than two
-- heartbeat intervals, closing at "now" would silently turn the offline gap
-- into study/observation time. Keep the helper independent of clock_timestamp
-- so every caller uses one transaction-consistent requested close instant.
create or replace function private.insight_safe_close_at(
  p_started_at timestamptz,
  p_last_confirmed_at timestamptz,
  p_requested_close_at timestamptz
)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  with bounds as (
    select
      p_started_at as started_at,
      greatest(
        p_started_at,
        coalesce(p_last_confirmed_at, p_started_at)
      ) as confirmed_at,
      greatest(
        p_started_at,
        coalesce(
          p_requested_close_at,
          p_last_confirmed_at,
          p_started_at
        )
      ) as requested_at
  )
  select case
    when requested_at <= confirmed_at + interval '2 minutes'
      then greatest(started_at, requested_at)
    else greatest(started_at, confirmed_at)
  end
  from bounds;
$$;

revoke all on function private.insight_safe_close_at(
  timestamptz, timestamptz, timestamptz
) from public, anon, authenticated;

-- The insert caps and account-merge preflight share the same transaction lock.
-- Without this, a concurrent capture could pass both count checks and cross the
-- per-user limit while an anonymous history is being transferred.
create or replace function private.lock_insight_owner(p_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('studytrace:insights:' || p_user_id::text, 0)
  );
$$;

revoke all on function private.lock_insight_owner(uuid)
  from public, anon, authenticated;

-- PR3 owns the fixed account-flow lock order and calls this intentionally
-- replaceable hook before it acquires any auth/session/token/data row lock.
-- Keep this function insight-only: replacing the PR3 core helper here would
-- silently discard the account/AI quota locks that it already holds.
create or replace function private.lock_account_flow_extension_resources(
  p_ordered_user_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid;
begin
  for owner_id in
    select candidate.user_id
    from pg_catalog.unnest(
      coalesce(p_ordered_user_ids, array[]::uuid[])
    ) as candidate(user_id)
    where candidate.user_id is not null
    group by candidate.user_id
    order by candidate.user_id::text
  loop
    perform private.lock_insight_owner(owner_id);
  end loop;
end;
$$;

revoke all on function private.lock_account_flow_extension_resources(uuid[])
  from public, anon, authenticated;

-- Acquire PR3's exact first-level owner key before the insight-specific
-- advisory. Taking the same transaction lock directly keeps this PR4 branch
-- resettable on its own; after rebase, calls through PR3's helper are re-entrant.
create or replace function private.lock_insight_parent_flow(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null then return; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'studytrace:owner-mutation:' || p_user_id::text,
      0
    )
  );
  perform private.lock_insight_owner(p_user_id);
end;
$$;

revoke all on function private.lock_insight_parent_flow(uuid)
  from public, anon, authenticated;

-- Reminder responses lock their row before issuing the UPDATE that activates
-- statement triggers. Take the global owner/insight order explicitly first so
-- an account merge cannot wait on this row while the response waits on the
-- merge's advisory lock.
create or replace function public.respond_to_reminder(
  p_reminder_id uuid,
  p_response text
)
returns public.reminder_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  selected_reminder public.reminder_events;
begin
  if caller_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_response not in (
    'dismissed',
    'back_to_task',
    'normal_activity',
    'not_needed',
    'later'
  ) then
    raise exception 'Unsupported reminder response' using errcode = '22023';
  end if;

  perform private.lock_insight_parent_flow(caller_id);

  select *
  into selected_reminder
  from public.reminder_events
  where id = p_reminder_id
    and user_id = caller_id
  for update;

  if not found then
    raise exception 'Reminder not found' using errcode = 'P0002';
  end if;

  if selected_reminder.response = 'none' then
    update public.reminder_events
    set response = p_response
    where id = selected_reminder.id
      and user_id = caller_id
    returning * into selected_reminder;
  end if;

  return selected_reminder;
end;
$$;

revoke all on function public.respond_to_reminder(uuid, text)
  from public, anon, authenticated;
grant execute on function public.respond_to_reminder(uuid, text)
  to authenticated;

-- This RPC's first write would already be protected by the settings statement
-- trigger. Taking the same re-entrant lock explicitly makes the lifecycle ABI
-- auditable and keeps future pre-write reads from accidentally reversing it.
create or replace function public.update_my_insights_preferences(
  p_enabled boolean,
  p_timezone text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  updated_settings public.user_settings;
begin
  if caller_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_enabled is null or p_timezone is null then
    raise exception 'Insight preference values are required'
      using errcode = '22023';
  end if;

  perform private.lock_insight_parent_flow(caller_id);

  update public.user_settings
  set insights_enabled = p_enabled,
      insights_timezone = p_timezone
  where user_id = caller_id
  returning * into updated_settings;

  if not found then
    raise exception 'User settings not found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'enabled', updated_settings.insights_enabled,
    'timezone', updated_settings.insights_timezone
  );
end;
$$;

revoke all on function public.update_my_insights_preferences(boolean, text)
  from public, anon, authenticated;
grant execute on function public.update_my_insights_preferences(boolean, text)
  to authenticated;

-- Keep the public data-clear contract complete even for a legacy/partially
-- provisioned user that has a truncation marker but no user_settings row. The
-- settings DELETE trigger remains a defense-in-depth cleanup path.
create or replace function public.delete_my_data()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
begin
  if caller_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'studytrace:owner-mutation:' || caller_id::text,
      0
    )
  );
  perform private.lock_insight_owner(caller_id);

  delete from public.reminder_events where user_id = caller_id;
  delete from public.behavior_events where user_id = caller_id;
  delete from public.reviews where user_id = caller_id;
  delete from public.study_sessions where user_id = caller_id;
  delete from public.tasks where user_id = caller_id;
  delete from public.user_settings where user_id = caller_id;
  delete from private.ai_generation_quota where user_id = caller_id;
  delete from private.insight_fact_coverage where user_id = caller_id;
end;
$$;

revoke all on function public.delete_my_data()
  from public, anon, authenticated;
grant execute on function public.delete_my_data() to authenticated;

comment on function public.delete_my_data() is
  'Deletes every auth.uid()-owned business, derived-insight, completeness, and transient AI quota row while retaining the identity.';

-- Ordinary app writes otherwise acquire a parent row lock before their AFTER
-- trigger inserts an insight fact. Account merge/delete/cleanup does the
-- opposite (insight advisory first, then parent row), which creates a classic
-- parent-row <-> advisory deadlock. App mutations always carry auth.uid(), so a
-- BEFORE STATEMENT trigger can take the same owner lock before PostgreSQL visits
-- any task/session/settings row. Account flows with a null or target-only
-- auth.uid() have already locked every source/target through the PR3 extension.
create or replace function private.lock_insight_owner_before_parent_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := auth.uid();
begin
  if owner_id is not null then
    perform private.lock_insight_parent_flow(owner_id);
  end if;
  return null;
end;
$$;

revoke all on function private.lock_insight_owner_before_parent_write()
  from public, anon, authenticated;

drop trigger if exists tasks_lock_insight_owner_before_write on public.tasks;
create trigger tasks_lock_insight_owner_before_write
before insert or delete or update of status, steps, user_id on public.tasks
for each statement
execute function private.lock_insight_owner_before_parent_write();

drop trigger if exists study_sessions_lock_insight_owner_before_write
  on public.study_sessions;
create trigger study_sessions_lock_insight_owner_before_write
before insert or delete or update of status, camera_enabled, user_id
on public.study_sessions
for each statement
execute function private.lock_insight_owner_before_parent_write();

-- Seal derived facts before the foundation migration's AFTER trigger sees the
-- state transition. That older trigger still attempts a wall-clock close, but
-- finds no open row after this guard. OLD.updated_at is the previous successful
-- server checkpoint, even though the generic updated_at trigger will stamp NEW.
create or replace function private.safely_close_session_insight_facts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  transition_at timestamptz := clock_timestamp();
  requested_close_at timestamptz;
  stale_session_gap boolean :=
    transition_at - old.updated_at > interval '2 minutes';
  capture_enabled boolean;
begin
  if old.status = 'running' and new.status <> 'running' then
    requested_close_at := case
      when new.status in ('completed', 'cancelled')
        then coalesce(new.ended_at, transition_at)
      else transition_at
    end;

    update public.session_segments as segment
    set ended_at = private.insight_safe_close_at(
      segment.started_at,
      old.updated_at,
      requested_close_at
    )
    where segment.session_id = old.id
      and segment.user_id = old.user_id
      and segment.ended_at is null;

    if stale_session_gap then
      -- Terminal/pause RPCs receive a browser elapsed value, but after two
      -- missed heartbeats neither it nor the server wall clock proves work.
      new.accumulated_seconds := old.accumulated_seconds;
    end if;
  elsif old.status = 'running'
    and new.status = 'running'
    and old.camera_enabled is distinct from new.camera_enabled
    and stale_session_gap
  then
    -- A camera control is proof the browser has returned, but not proof of the
    -- offline interval. Rebase the timer and fact interval at this action so
    -- the generic updated_at trigger cannot bridge the gap.
    update public.session_segments as segment
    set ended_at = private.insight_safe_close_at(
      segment.started_at,
      old.updated_at,
      transition_at
    )
    where segment.session_id = old.id
      and segment.user_id = old.user_id
      and segment.ended_at is null;

    new.accumulated_seconds := old.accumulated_seconds;
    new.resumed_at := transition_at;

    select coalesce(settings.insights_enabled, true)
    into capture_enabled
    from public.user_settings as settings
    where settings.user_id = old.user_id;
    capture_enabled := coalesce(capture_enabled, true);

    if capture_enabled then
      insert into public.session_segments (
        user_id, session_id, started_at, origin
      ) values (
        old.user_id, old.id, transition_at, 'runtime'
      );
    end if;
  end if;

  if (old.status = 'running' and new.status <> 'running')
    or (old.camera_enabled and not new.camera_enabled)
  then
    requested_close_at := case
      when new.status in ('completed', 'cancelled')
        then coalesce(new.ended_at, transition_at)
      else transition_at
    end;

    update public.observation_runs as observation
    set ended_at = private.insight_safe_close_at(
      observation.started_at,
      observation.last_observed_at,
      greatest(requested_close_at, observation.last_observed_at)
    )
    where observation.session_id = old.id
      and observation.user_id = old.user_id
      and observation.ended_at is null;
  end if;

  return new;
end;
$$;

revoke all on function private.safely_close_session_insight_facts()
  from public, anon, authenticated;

drop trigger if exists study_sessions_safely_close_insight_facts
  on public.study_sessions;
create trigger study_sessions_safely_close_insight_facts
before update of status, camera_enabled on public.study_sessions
for each row execute function private.safely_close_session_insight_facts();

-- A controlled account merge changes only the owner. The generic updated_at
-- trigger must not turn that administrative transfer into a timer heartbeat;
-- otherwise an hour-old open segment becomes fresh and the next checkpoint
-- backfills the whole offline gap. This trigger sorts after set_updated_at and
-- restores the previous confirmation timestamp for the exact GUC-guarded move.
create or replace function private.preserve_session_confirmation_on_owner_move()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  merge_source text := current_setting(
    'studytrace.account_merge_source',
    true
  );
  merge_target text := current_setting(
    'studytrace.account_merge_target',
    true
  );
begin
  if new.user_id is distinct from old.user_id
    and merge_source = old.user_id::text
    and merge_target = new.user_id::text
    and (to_jsonb(new) - 'user_id' - 'updated_at')
      = (to_jsonb(old) - 'user_id' - 'updated_at')
  then
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;

revoke all on function private.preserve_session_confirmation_on_owner_move()
  from public, anon, authenticated;

drop trigger if exists study_sessions_z_preserve_confirmation_on_owner_move
  on public.study_sessions;
create trigger study_sessions_z_preserve_confirmation_on_owner_move
before update of user_id on public.study_sessions
for each row
execute function private.preserve_session_confirmation_on_owner_move();

drop trigger if exists user_settings_lock_insight_owner_before_write
  on public.user_settings;
create trigger user_settings_lock_insight_owner_before_write
before delete or update of insights_enabled, user_id on public.user_settings
for each statement
execute function private.lock_insight_owner_before_parent_write();

create or replace function private.limit_insight_fact_growth()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := new.user_id;
  parent_id uuid;
  user_rows bigint;
  parent_rows bigint;
  per_user_limit integer;
  per_parent_limit integer;
begin
  case tg_table_name
    when 'session_segments' then
      parent_id := new.session_id;
      per_user_limit := 25000;
      per_parent_limit := 1000;
    when 'observation_runs' then
      parent_id := new.session_id;
      per_user_limit := 25000;
      per_parent_limit := 1000;
    when 'task_lifecycle_events' then
      parent_id := new.task_id;
      per_user_limit := 20000;
      per_parent_limit := 500;
    when 'task_step_events' then
      parent_id := new.task_id;
      per_user_limit := 50000;
      per_parent_limit := 5000;
    else
      raise exception 'Unsupported insight fact table: %', tg_table_name;
  end case;

  perform private.lock_insight_owner(owner_id);

  -- Both quota dimensions are read after the owner lock. All fact inserts and
  -- account merges take this lock, so concurrent inserts cannot race the cap.
  execute format('select count(*) from public.%I where user_id = $1', tg_table_name)
    into user_rows using owner_id;
  execute format(
    'select count(*) from public.%I where %I = $1',
    tg_table_name,
    case when tg_table_name in ('session_segments', 'observation_runs')
      then 'session_id' else 'task_id' end
  ) into parent_rows using parent_id;

  if user_rows >= per_user_limit or parent_rows >= per_parent_limit then
    insert into private.insight_fact_coverage (
      user_id, truncated, first_truncated_at, last_truncated_at,
      dropped_counts, updated_at
    ) values (
      owner_id, true, clock_timestamp(), clock_timestamp(),
      jsonb_build_object(tg_table_name, 1), clock_timestamp()
    )
    on conflict (user_id) do update set
      truncated = true,
      first_truncated_at = coalesce(
        private.insight_fact_coverage.first_truncated_at,
        excluded.first_truncated_at
      ),
      last_truncated_at = excluded.last_truncated_at,
      dropped_counts = private.insight_fact_coverage.dropped_counts
        || jsonb_build_object(
          tg_table_name,
          coalesce((private.insight_fact_coverage.dropped_counts
            ->> tg_table_name)::bigint, 0) + 1
        ),
      updated_at = excluded.updated_at;
    return null;
  end if;
  return new;
end;
$$;

revoke all on function private.limit_insight_fact_growth()
  from public, anon, authenticated;

create or replace function private.ensure_insight_merge_capacity(
  p_source_user_id uuid,
  p_target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  combined_count bigint;
begin
  if p_source_user_id = p_target_user_id then
    raise exception 'Insight merge source and target must differ'
      using errcode = '22023';
  end if;

  if p_source_user_id::text < p_target_user_id::text then
    perform private.lock_insight_owner(p_source_user_id);
    perform private.lock_insight_owner(p_target_user_id);
  else
    perform private.lock_insight_owner(p_target_user_id);
    perform private.lock_insight_owner(p_source_user_id);
  end if;

  select count(*) into combined_count from public.session_segments
    where user_id in (p_source_user_id, p_target_user_id);
  if combined_count > 25000 then
    raise exception 'Merged session-segment history exceeds the safety limit'
      using errcode = '54000';
  end if;

  select count(*) into combined_count from public.observation_runs
    where user_id in (p_source_user_id, p_target_user_id);
  if combined_count > 25000 then
    raise exception 'Merged observation history exceeds the safety limit'
      using errcode = '54000';
  end if;

  select count(*) into combined_count from public.task_lifecycle_events
    where user_id in (p_source_user_id, p_target_user_id);
  if combined_count > 20000 then
    raise exception 'Merged task lifecycle history exceeds the safety limit'
      using errcode = '54000';
  end if;

  select count(*) into combined_count from public.task_step_events
    where user_id in (p_source_user_id, p_target_user_id);
  if combined_count > 50000 then
    raise exception 'Merged task-step history exceeds the safety limit'
      using errcode = '54000';
  end if;
end;
$$;

revoke all on function private.ensure_insight_merge_capacity(uuid, uuid)
  from public, anon, authenticated;

-- PR3 invokes this replaceable hook only after the account-flow advisory locks,
-- auth/session/token re-read, and OTP/email validation, but before any owner
-- mutation. Resolving the target during the unauthenticated prepare phase would
-- leak account existence through capacity errors.
create or replace function private.assert_account_merge_extension_capacity(
  p_source_user_id uuid,
  p_target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.ensure_insight_merge_capacity(
    p_source_user_id,
    p_target_user_id
  );
end;
$$;

revoke all on function private.assert_account_merge_extension_capacity(uuid, uuid)
  from public, anon, authenticated;

create or replace function private.merge_insight_coverage(
  p_source_user_id uuid,
  p_target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_coverage private.insight_fact_coverage;
  source_pair record;
  target_existed boolean;
begin
  select * into source_coverage
  from private.insight_fact_coverage
  where user_id = p_source_user_id
  for update;

  if not found then return; end if;

  select exists (
    select 1 from private.insight_fact_coverage
    where user_id = p_target_user_id
  ) into target_existed;

  insert into private.insight_fact_coverage (
    user_id, truncated, first_truncated_at, last_truncated_at,
    dropped_counts, created_at, updated_at
  ) values (
    p_target_user_id, source_coverage.truncated,
    source_coverage.first_truncated_at, source_coverage.last_truncated_at,
    source_coverage.dropped_counts, source_coverage.created_at,
    source_coverage.updated_at
  )
  on conflict (user_id) do update set
    truncated = private.insight_fact_coverage.truncated or excluded.truncated,
    first_truncated_at = least(
      private.insight_fact_coverage.first_truncated_at,
      excluded.first_truncated_at
    ),
    last_truncated_at = greatest(
      private.insight_fact_coverage.last_truncated_at,
      excluded.last_truncated_at
    ),
    updated_at = greatest(
      private.insight_fact_coverage.updated_at,
      excluded.updated_at
    );

  if target_existed then
    for source_pair in
      select key, value from jsonb_each_text(source_coverage.dropped_counts)
    loop
      update private.insight_fact_coverage
      set dropped_counts = dropped_counts || jsonb_build_object(
        source_pair.key,
        coalesce((dropped_counts ->> source_pair.key)::bigint, 0)
          + source_pair.value::bigint
      )
      where user_id = p_target_user_id;
    end loop;
  end if;

  delete from private.insight_fact_coverage
  where user_id = p_source_user_id;
end;
$$;

revoke all on function private.merge_insight_coverage(uuid, uuid)
  from public, anon, authenticated;

-- PR3 calls this replaceable mutation hook exactly once after all merge
-- validation/capacity checks and before settings/tasks/sessions are moved. This
-- explicit step also preserves a truncation marker when the source has already
-- deleted every public parent row (and even its settings row).
create or replace function private.apply_account_merge_extension(
  p_source_user_id uuid,
  p_target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  merge_at timestamptz := clock_timestamp();
  target_capture_enabled boolean;
begin
  select coalesce(settings.insights_enabled, true)
  into target_capture_enabled
  from public.user_settings as settings
  where settings.user_id = p_target_user_id;
  target_capture_enabled := coalesce(target_capture_enabled, true);

  -- The permanent account's setting wins. If it has capture disabled, seal the
  -- anonymous intervals before owner transfer; a stale browser gap is bounded
  -- by its last server confirmation, not by the merge timestamp.
  if not target_capture_enabled then
    update public.session_segments as segment
    set ended_at = private.insight_safe_close_at(
      segment.started_at,
      session.updated_at,
      merge_at
    )
    from public.study_sessions as session
    where segment.user_id = p_source_user_id
      and segment.session_id = session.id
      and session.user_id = p_source_user_id
      and segment.ended_at is null;

    update public.observation_runs as observation
    set ended_at = private.insight_safe_close_at(
      observation.started_at,
      observation.last_observed_at,
      greatest(merge_at, observation.last_observed_at)
    )
    where observation.user_id = p_source_user_id
      and observation.ended_at is null;
  end if;

  perform private.merge_insight_coverage(
    p_source_user_id,
    p_target_user_id
  );
end;
$$;

revoke all on function private.apply_account_merge_extension(uuid, uuid)
  from public, anon, authenticated;

create or replace function private.clear_insight_coverage_with_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Account merge has already transferred the private marker through its
  -- explicit extension hook. Preserve compatibility with the pre-hook PR3
  -- migration while rebases/previews briefly contain the older consume RPC.
  if current_setting('studytrace.account_merge_source', true) = old.user_id::text
  then
    return old;
  end if;

  delete from private.insight_fact_coverage where user_id = old.user_id;
  return old;
end;
$$;

revoke all on function private.clear_insight_coverage_with_settings()
  from public, anon, authenticated;

create trigger user_settings_clear_insight_coverage
after delete on public.user_settings
for each row execute function private.clear_insight_coverage_with_settings();

create or replace function private.prepare_insight_owner_merge(
  p_source_user_id uuid,
  p_target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('studytrace.insight_merge_checked', true) = 'true' then
    return;
  end if;
  perform private.ensure_insight_merge_capacity(
    p_source_user_id, p_target_user_id
  );
  perform private.merge_insight_coverage(p_source_user_id, p_target_user_id);
  perform set_config('studytrace.insight_merge_checked', 'true', true);
end;
$$;

revoke all on function private.prepare_insight_owner_merge(uuid, uuid)
  from public, anon, authenticated;

create or replace function private.cascade_task_insight_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id then
    perform private.prepare_insight_owner_merge(old.user_id, new.user_id);
    update public.task_lifecycle_events set user_id = new.user_id
      where task_id = new.id and user_id = old.user_id;
    update public.task_step_events set user_id = new.user_id
      where task_id = new.id and user_id = old.user_id;
  end if;
  return new;
end;
$$;

revoke all on function private.cascade_task_insight_owner()
  from public, anon, authenticated;

create or replace function private.cascade_session_insight_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id then
    perform private.prepare_insight_owner_merge(old.user_id, new.user_id);
    update public.session_segments set user_id = new.user_id
      where session_id = new.id and user_id = old.user_id;
    update public.observation_runs set user_id = new.user_id
      where session_id = new.id and user_id = old.user_id;
  end if;
  return new;
end;
$$;

revoke all on function private.cascade_session_insight_owner()
  from public, anon, authenticated;

create or replace function private.transition_insight_capture_preference()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  transition_at timestamptz := clock_timestamp();
  active_session public.study_sessions;
begin
  if old.insights_enabled is not distinct from new.insights_enabled then
    return new;
  end if;

  select * into active_session
  from public.study_sessions
  where user_id = new.user_id and status = 'running'
  for update;

  if not new.insights_enabled then
    update public.session_segments as segment
    set ended_at = private.insight_safe_close_at(
      segment.started_at,
      session.updated_at,
      transition_at
    )
    from public.study_sessions as session
    where segment.user_id = new.user_id
      and segment.session_id = session.id
      and session.user_id = new.user_id
      and segment.ended_at is null;

    update public.observation_runs as observation
    set ended_at = private.insight_safe_close_at(
      observation.started_at,
      observation.last_observed_at,
      greatest(transition_at, observation.last_observed_at)
    )
    where observation.user_id = new.user_id
      and observation.ended_at is null;
    return new;
  end if;

  -- Re-enabling starts a fresh fact interval at the server transition time. It
  -- never reconstructs or backfills the period during which capture was off.
  if found then
    insert into public.session_segments (
      user_id, session_id, started_at, origin
    )
    select new.user_id, active_session.id, transition_at, 'runtime'
    where not exists (
      select 1 from public.session_segments
      where session_id = active_session.id and ended_at is null
    );

    if active_session.camera_enabled then
      insert into public.observation_runs (
        user_id, session_id, started_at, last_observed_at, camera_version,
        observation_profile, detector_version, experiment_mode,
        policy_snapshot, threshold_snapshot, origin
      )
      select
        new.user_id,
        active_session.id,
        transition_at,
        transition_at,
        active_session.camera_version,
        active_session.observation_profile,
        'mediapipe-face-landmarker@1.0.1',
        active_session.experiment_mode,
        jsonb_build_object(
          'profile', active_session.observation_profile,
          'face_absent', active_session.observation_profile <> 'off_device_v1',
          'yaw', active_session.observation_profile <> 'off_device_v1',
          'pitch', active_session.observation_profile = 'study_screen_v1'
        ),
        jsonb_build_object(
          'calibration_seconds', new.calibration_seconds,
          'sample_fps', new.sample_fps,
          'face_absent_seconds', new.face_absent_seconds,
          'direction_hold_seconds', new.direction_hold_seconds,
          'neutral_recovery_seconds', new.neutral_recovery_seconds,
          'reminder_delay_seconds', new.reminder_delay_seconds,
          'reminder_cooldown_seconds', new.reminder_cooldown_seconds,
          'yaw_threshold_degrees', new.yaw_threshold_degrees,
          'pitch_threshold_degrees', new.pitch_threshold_degrees
        ),
        'runtime'
      where not exists (
        select 1 from public.observation_runs
        where session_id = active_session.id and ended_at is null
      );
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.transition_insight_capture_preference()
  from public, anon, authenticated;

create trigger user_settings_transition_insight_capture
after update of insights_enabled on public.user_settings
for each row execute function private.transition_insight_capture_preference();

-- A browser can disappear without firing pause/unload. Checkpoints are the
-- server's proof that a running timer is still alive. After two missed 60s
-- heartbeats, seal the old fact at its last server-confirmed timestamp, discard
-- the unproven wall-clock delta from accumulated time, and restart now.
create or replace function public.checkpoint_running_session(
  p_session_id uuid,
  p_expected_resumed_at timestamptz,
  p_accumulated_seconds integer,
  p_checkpointed_at timestamptz
)
returns public.study_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  selected_session public.study_sessions;
  checkpoint_now timestamptz := clock_timestamp();
  accepted_accumulated_seconds integer;
  accepted_resumed_at timestamptz;
  stale_gap boolean;
  capture_enabled boolean;
begin
  if caller_id is null then
    raise exception 'Anonymous experience is not ready' using errcode = '42501';
  end if;
  if p_expected_resumed_at is null or p_checkpointed_at is null then
    raise exception 'Timer checkpoint anchors cannot be null'
      using errcode = '22023';
  end if;
  if p_accumulated_seconds is null or p_accumulated_seconds < 0 then
    raise exception 'Accumulated seconds cannot be negative or null'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'studytrace:owner-mutation:' || caller_id::text,
      0
    )
  );
  perform private.lock_insight_owner(caller_id);

  select * into selected_session
  from public.study_sessions
  where id = p_session_id and user_id = caller_id
  for update;

  if not found then
    raise exception 'Study session not found' using errcode = 'P0002';
  end if;

  if selected_session.status = 'running'
    and selected_session.resumed_at is not distinct from p_expected_resumed_at
    and p_checkpointed_at >= selected_session.resumed_at
    and p_accumulated_seconds >= selected_session.accumulated_seconds
  then
    select coalesce(settings.insights_enabled, true)
    into capture_enabled
    from public.user_settings as settings
    where settings.user_id = caller_id;
    capture_enabled := coalesce(capture_enabled, true);

    stale_gap := checkpoint_now - selected_session.updated_at > interval '2 minutes';
    accepted_accumulated_seconds := case
      when stale_gap then selected_session.accumulated_seconds
      else p_accumulated_seconds
    end;
    accepted_resumed_at := case
      when stale_gap then checkpoint_now
      else p_checkpointed_at
    end;

    if stale_gap and capture_enabled then
      update public.session_segments
      set ended_at = private.insight_safe_close_at(
        started_at,
        selected_session.updated_at,
        checkpoint_now
      )
      where user_id = caller_id
        and session_id = selected_session.id
        and ended_at is null;
    end if;

    update public.study_sessions
    set
      accumulated_seconds = accepted_accumulated_seconds,
      resumed_at = accepted_resumed_at
    where id = selected_session.id and user_id = caller_id
    returning * into selected_session;

    -- A merge can legitimately switch from an anonymous profile that had
    -- capture disabled to a permanent profile that enables it. The first
    -- authenticated checkpoint is the earliest reliable restart boundary.
    if capture_enabled then
      insert into public.session_segments (
        user_id, session_id, started_at, origin
      )
      select caller_id, selected_session.id, checkpoint_now, 'runtime'
      where not exists (
        select 1 from public.session_segments
        where session_id = selected_session.id and ended_at is null
      );
    end if;
  end if;

  return selected_session;
end;
$$;

revoke all on function public.checkpoint_running_session(
  uuid, timestamptz, integer, timestamptz
) from public, anon, authenticated;
grant execute on function public.checkpoint_running_session(
  uuid, timestamptz, integer, timestamptz
) to authenticated;

comment on function public.checkpoint_running_session(
  uuid, timestamptz, integer, timestamptz
) is
  'Advances an owned running timer and excludes gaps longer than two missed 60-second server checkpoints.';

create or replace function public.heartbeat_observation_run(
  p_session_id uuid,
  p_expected_state_version bigint,
  p_camera_version bigint
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  selected_session public.study_sessions;
  selected_run public.observation_runs;
  observed_at timestamptz := clock_timestamp();
  policy_snapshot jsonb;
  threshold_snapshot jsonb;
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_session_id is null
    or p_expected_state_version is null or p_expected_state_version < 0
    or p_camera_version is null or p_camera_version < 1
  then
    raise exception 'Valid observation heartbeat versions are required'
      using errcode = '22023';
  end if;

  perform private.lock_insight_parent_flow(caller_id);

  select * into selected_session
  from public.study_sessions
  where id = p_session_id and user_id = caller_id
  for update;

  if not found then
    raise exception 'Study session not found' using errcode = 'P0002';
  end if;
  if selected_session.status <> 'running'
    or not selected_session.camera_enabled
    or selected_session.state_version <> p_expected_state_version
    or selected_session.camera_version <> p_camera_version
  then
    raise exception 'Observation heartbeat is stale'
      using errcode = '40001';
  end if;

  select * into selected_run
  from public.observation_runs
  where user_id = caller_id
    and session_id = p_session_id
    and camera_version = p_camera_version
    and ended_at is null
  for update;

  if not found then
    -- Capture is intentionally absent while insights are disabled. Returning a
    -- nullable value would hide camera/version drift, so distinguish this safe
    -- no-op from an unexpected missing run.
    if exists (
      select 1 from public.user_settings
      where user_id = caller_id and not insights_enabled
    ) then
      return null;
    end if;

    -- An account merge may preserve a running camera session while changing
    -- the winning insights preference. A valid, version-matched worker
    -- heartbeat is sufficient proof to start observation from this instant;
    -- never reconstruct the preceding gap.
    select
      jsonb_build_object(
        'profile', selected_session.observation_profile,
        'face_absent', selected_session.observation_profile <> 'off_device_v1',
        'yaw', selected_session.observation_profile <> 'off_device_v1',
        'pitch', selected_session.observation_profile = 'study_screen_v1'
      ),
      jsonb_build_object(
        'calibration_seconds', settings.calibration_seconds,
        'sample_fps', settings.sample_fps,
        'face_absent_seconds', settings.face_absent_seconds,
        'direction_hold_seconds', settings.direction_hold_seconds,
        'neutral_recovery_seconds', settings.neutral_recovery_seconds,
        'reminder_delay_seconds', settings.reminder_delay_seconds,
        'reminder_cooldown_seconds', settings.reminder_cooldown_seconds,
        'yaw_threshold_degrees', settings.yaw_threshold_degrees,
        'pitch_threshold_degrees', settings.pitch_threshold_degrees
      )
    into policy_snapshot, threshold_snapshot
    from public.user_settings as settings
    where settings.user_id = caller_id;

    insert into public.observation_runs (
      user_id,
      session_id,
      started_at,
      last_observed_at,
      camera_version,
      observation_profile,
      detector_version,
      experiment_mode,
      policy_snapshot,
      threshold_snapshot,
      origin
    ) values (
      caller_id,
      selected_session.id,
      observed_at,
      observed_at,
      selected_session.camera_version,
      selected_session.observation_profile,
      'mediapipe-face-landmarker@1.0.1',
      selected_session.experiment_mode,
      coalesce(policy_snapshot, '{}'::jsonb),
      coalesce(threshold_snapshot, '{}'::jsonb),
      'runtime'
    );

    return observed_at;
  end if;

  if observed_at - selected_run.last_observed_at > interval '2 minutes' then
    update public.observation_runs
    set ended_at = greatest(started_at, last_observed_at)
    where id = selected_run.id;

    insert into public.observation_runs (
      user_id,
      session_id,
      started_at,
      last_observed_at,
      camera_version,
      observation_profile,
      detector_version,
      experiment_mode,
      policy_snapshot,
      threshold_snapshot,
      origin
    ) values (
      selected_run.user_id,
      selected_run.session_id,
      observed_at,
      observed_at,
      selected_run.camera_version,
      selected_run.observation_profile,
      selected_run.detector_version,
      selected_run.experiment_mode,
      selected_run.policy_snapshot,
      selected_run.threshold_snapshot,
      selected_run.origin
    );
  else
    update public.observation_runs
    set last_observed_at = greatest(last_observed_at, observed_at)
    where id = selected_run.id;
  end if;

  return observed_at;
end;
$$;

revoke all on function public.heartbeat_observation_run(uuid, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.heartbeat_observation_run(uuid, bigint, bigint)
  to authenticated;

comment on function public.heartbeat_observation_run(uuid, bigint, bigint) is
  'Confirms only that the authenticated owner camera worker is still observing; stores no frame, landmark, or biometric data.';
