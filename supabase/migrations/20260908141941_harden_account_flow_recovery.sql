-- Make account switching explicitly cancellable, safely retryable after a lost
-- HTTP response, and unable to bypass the per-user storage or AI quotas.

-- A merge bearer stays in one row for its entire lifetime. Moving that row from
-- `prepared` to `consumed` in the same transaction as the ownership transfer
-- avoids a gap where a retry could observe neither the request nor its receipt.
alter table private.account_merge_tokens
  drop constraint account_merge_tokens_short_lived,
  alter column source_user_id drop not null,
  alter column source_session_id drop not null,
  add column merge_state text not null default 'prepared',
  add column target_user_id uuid
    references auth.users(id) on delete cascade,
  add column target_session_id uuid
    references auth.sessions(id) on delete cascade,
  add column consumed_at timestamptz,
  add column consume_receipt jsonb,
  add constraint account_merge_tokens_hash_lengths check (
    octet_length(token_hash) = 32
    and octet_length(target_email_hash) = 32
  ),
  add constraint account_merge_tokens_state_valid check (
    (
      merge_state = 'prepared'
      and source_user_id is not null
      and source_session_id is not null
      and target_user_id is null
      and target_session_id is null
      and consumed_at is null
      and consume_receipt is null
      and expires_at > created_at
      and expires_at <= created_at + interval '10 minutes'
    )
    or
    (
      merge_state = 'consumed'
      and source_user_id is null
      and source_session_id is null
      and target_user_id is not null
      and target_session_id is not null
      and consumed_at is not null
      and consumed_at >= created_at
      and jsonb_typeof(consume_receipt) = 'object'
      and expires_at > consumed_at
      and expires_at <= consumed_at + interval '30 minutes'
    )
  );

create index account_merge_tokens_consumed_target_idx
  on private.account_merge_tokens (target_user_id, target_session_id)
  where merge_state = 'consumed';

-- A single first-level owner key serializes every mutation for one identity.
-- Account transitions take the same keys for all involved identities in UUID
-- text order before any table-specific advisory, auth row, parent row, or FK.
create or replace function private.lock_owner_mutation_resources(
  p_user_ids uuid[]
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  resource_user_id uuid;
begin
  for resource_user_id in
    select supplied.user_id
    from (
      select distinct candidate.user_id
      from unnest(p_user_ids) as candidate(user_id)
      where candidate.user_id is not null
    ) as supplied
    order by supplied.user_id::text
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'studytrace:owner-mutation:' || resource_user_id::text,
        0
      )
    );
  end loop;
end;
$$;

revoke all on function private.lock_owner_mutation_resources(uuid[])
  from public, anon, authenticated;

-- user_settings has no ordinary per-table quota trigger, so its own secondary
-- key protects a missing-row INSERT and owner transition after the first-level
-- owner key has been taken.
create or replace function private.lock_account_settings_resources(
  p_user_ids uuid[]
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  resource_user_id uuid;
begin
  for resource_user_id in
    select supplied.user_id
    from (
      select distinct candidate.user_id
      from unnest(p_user_ids) as candidate(user_id)
      where candidate.user_id is not null
    ) as supplied
    order by supplied.user_id::text
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'studytrace.user_settings:' || resource_user_id::text,
        0
      )
    );
  end loop;
end;
$$;

revoke all on function private.lock_account_settings_resources(uuid[])
  from public, anon, authenticated;

-- Direct PostgREST writes have no RPC entry point. PostgreSQL runs same-kind
-- triggers by name, so the `a0_` dispatcher is the first BEFORE STATEMENT
-- trigger. PR4 appends its insight-owner statement trigger after this one.
create or replace function private.lock_current_owner_statement_resources()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
begin
  if caller_id is null then
    return null;
  end if;

  perform private.lock_owner_mutation_resources(array[caller_id]);
  if tg_table_schema = 'public' and tg_table_name = 'user_settings' then
    perform private.lock_account_settings_resources(array[caller_id]);
  end if;
  return null;
end;
$$;

revoke all on function private.lock_current_owner_statement_resources()
  from public, anon, authenticated;

do $owner_statement_triggers$
declare
  business_table text;
begin
  foreach business_table in array array[
    'tasks',
    'study_sessions',
    'behavior_events',
    'reminder_events',
    'reviews',
    'user_settings'
  ] loop
    execute pg_catalog.format(
      'drop trigger if exists a0_lock_account_owner_mutation on public.%I',
      business_table
    );
    execute pg_catalog.format(
      'create trigger a0_lock_account_owner_mutation '
      || 'before insert or update or delete on public.%I '
      || 'for each statement execute function '
      || 'private.lock_current_owner_statement_resources()',
      business_table
    );
  end loop;
end;
$owner_statement_triggers$;

-- Existing lifecycle RPCs can lock parent/session rows before issuing their
-- first DML statement. Inject the owner key at the outer function entry so
-- those row locks cannot precede it. The assertion makes a schema drift fail
-- during migration instead of silently leaving one path unguarded.
do $guard_existing_mutating_rpcs$
declare
  mutating_rpc regprocedure;
  original_definition text;
  guarded_definition text;
begin
  foreach mutating_rpc in array array[
    'public.set_task_step_completed(uuid,text,boolean)'::regprocedure,
    'public.confirm_task_completion(uuid,integer)'::regprocedure,
    'public.reopen_completed_task(uuid)'::regprocedure,
    'public.start_study_session(uuid,boolean,boolean)'::regprocedure,
    'public.cancel_study_session(uuid,integer)'::regprocedure,
    'public.pause_study_session(uuid,bigint,integer)'::regprocedure,
    'public.resume_study_session(uuid,bigint)'::regprocedure,
    'public.set_study_session_camera(uuid,bigint,bigint,boolean)'::regprocedure,
    'public.checkpoint_running_session(uuid,timestamptz,integer,timestamptz)'::regprocedure,
    'public.finish_study_session(uuid,integer,text)'::regprocedure,
    'public.pause_study_session_for_navigation(uuid)'::regprocedure,
    'public.delete_my_data()'::regprocedure
  ] loop
    original_definition := pg_catalog.pg_get_functiondef(mutating_rpc);
    guarded_definition := pg_catalog.regexp_replace(
      original_definition,
      E'\\nbegin\\n',
      E'\nbegin\n  perform pg_catalog.pg_advisory_xact_lock(\n'
        || E'    pg_catalog.hashtextextended(\n'
        || E'      ''studytrace:owner-mutation:'' || auth.uid()::text,\n'
        || E'      0\n'
        || E'    )\n'
        || E'  );\n'
    );

    if guarded_definition = original_definition then
      raise exception 'Could not guard mutating RPC %', mutating_rpc
        using errcode = 'P0001';
    end if;

    execute guarded_definition;
  end loop;
end;
$guard_existing_mutating_rpcs$;

-- Account-flow writers take owner resources before the common
-- user -> current session -> token row order. Besides avoiding deadlocks, this
-- prevents a session from disappearing between validation and bearer writes.
create or replace function public.prepare_account_merge(
  p_token text,
  p_target_email text
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_is_anonymous boolean;
  caller_session_id uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
  existing_token private.account_merge_tokens;
  token_created_at timestamptz := clock_timestamp();
  token_expiry timestamptz := token_created_at + interval '10 minutes';
  normalized_email text := lower(btrim(p_target_email));
begin
  if caller_id is null or caller_session_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if p_token is null
    or char_length(p_token) <> 64
    or p_token !~ '^[A-Fa-f0-9]{64}$'
  then
    raise exception 'Invalid account merge secret' using errcode = '22023';
  end if;

  if normalized_email is null
    or char_length(normalized_email) > 254
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  then
    raise exception 'Invalid target email' using errcode = '22023';
  end if;

  perform private.lock_owner_mutation_resources(array[caller_id]);

  select is_anonymous
  into caller_is_anonymous
  from auth.users
  where id = caller_id
  for update;

  if not found or caller_is_anonymous is not true then
    raise exception 'Only an anonymous account can prepare a merge'
      using errcode = '42501';
  end if;

  perform 1
  from auth.sessions
  where id = caller_session_id
    and user_id = caller_id
    and (not_after is null or not_after > clock_timestamp())
  for update;
  if not found then
    raise exception 'A current anonymous session is required'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.study_sessions
    where user_id = caller_id
      and status in ('running', 'paused')
  ) then
    raise exception 'End the current study session before switching accounts'
      using errcode = '55000';
  end if;

  update private.user_activity
  set last_active_at = greatest(last_active_at, clock_timestamp())
  where user_id = caller_id;
  if not found then
    raise exception 'Anonymous activity state is missing'
      using errcode = 'P0002';
  end if;

  select *
  into existing_token
  from private.account_merge_tokens
  where source_user_id = caller_id
    and merge_state = 'prepared'
  for update;

  if found and existing_token.expires_at > clock_timestamp() then
    if existing_token.token_hash = extensions.digest(p_token, 'sha256')
      and existing_token.target_email_hash
        = extensions.digest(normalized_email, 'sha256')
      and existing_token.source_session_id = caller_session_id
    then
      return existing_token.expires_at;
    end if;

    raise exception 'Another account merge is already in progress'
      using errcode = '55000';
  end if;

  if found then
    delete from private.account_merge_tokens
    where token_hash = existing_token.token_hash
      and merge_state = 'prepared';
  end if;

  insert into private.account_merge_tokens (
    token_hash,
    target_email_hash,
    source_user_id,
    source_session_id,
    created_at,
    expires_at
  )
  values (
    extensions.digest(p_token, 'sha256'),
    extensions.digest(normalized_email, 'sha256'),
    caller_id,
    caller_session_id,
    token_created_at,
    token_expiry
  );

  return token_expiry;
end;
$$;

revoke all on function public.prepare_account_merge(text, text)
  from public, anon;
grant execute on function public.prepare_account_merge(text, text)
  to authenticated;

create or replace function public.refresh_account_merge(p_token text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_session_id uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
  caller_is_anonymous boolean;
  prepared_expiry timestamptz;
begin
  if caller_id is null or caller_session_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if p_token is null
    or char_length(p_token) <> 64
    or p_token !~ '^[A-Fa-f0-9]{64}$'
  then
    raise exception 'Invalid account merge secret' using errcode = '22023';
  end if;

  perform private.lock_owner_mutation_resources(array[caller_id]);

  select is_anonymous
  into caller_is_anonymous
  from auth.users
  where id = caller_id
  for update;
  if not found or caller_is_anonymous is not true then
    raise exception 'A current anonymous session is required'
      using errcode = '42501';
  end if;

  perform 1
  from auth.sessions
  where id = caller_session_id
    and user_id = caller_id
    and (not_after is null or not_after > clock_timestamp())
  for update;
  if not found then
    raise exception 'A current anonymous session is required'
      using errcode = '42501';
  end if;

  update private.user_activity
  set last_active_at = greatest(last_active_at, clock_timestamp())
  where user_id = caller_id;
  if not found then
    raise exception 'Anonymous activity state is missing'
      using errcode = 'P0002';
  end if;

  select expires_at
  into prepared_expiry
  from private.account_merge_tokens
  where source_user_id = caller_id
    and source_session_id = caller_session_id
    and merge_state = 'prepared'
    and token_hash = extensions.digest(p_token, 'sha256')
    and expires_at > clock_timestamp()
  for update;

  if not found then
    raise exception 'Account merge request is invalid or expired'
      using errcode = '42501';
  end if;

  -- Resending an OTP never extends the bearer lifetime. The ten-minute
  -- window is absolute from the original prepare call, matching the client
  -- capability TTL and preventing a forgotten raw secret from being renewed.
  return prepared_expiry;
end;
$$;

revoke all on function public.refresh_account_merge(text)
  from public, anon;
grant execute on function public.refresh_account_merge(text)
  to authenticated;

create or replace function public.prepare_account_deletion(p_token text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_session_id uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
  caller_email text;
  caller_is_anonymous boolean;
  caller_email_confirmed_at timestamptz;
  caller_has_email_provider boolean;
  caller_has_phone_provider boolean;
  existing_token private.account_delete_tokens;
  token_created_at timestamptz := clock_timestamp();
  token_expiry timestamptz := token_created_at + interval '10 minutes';
begin
  if caller_id is null or caller_session_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if p_token is null
    or char_length(p_token) <> 64
    or p_token !~ '^[A-Fa-f0-9]{64}$'
  then
    raise exception 'Invalid account deletion secret' using errcode = '22023';
  end if;

  perform private.lock_owner_mutation_resources(array[caller_id]);

  select
    email,
    is_anonymous,
    email_confirmed_at,
    coalesce(raw_app_meta_data->>'provider' = 'email', false)
      or coalesce(raw_app_meta_data->'providers' ? 'email', false),
    coalesce(raw_app_meta_data->>'provider' = 'phone', false)
      or coalesce(raw_app_meta_data->'providers' ? 'phone', false)
      or nullif(btrim(coalesce(phone, '')), '') is not null
  into
    caller_email,
    caller_is_anonymous,
    caller_email_confirmed_at,
    caller_has_email_provider,
    caller_has_phone_provider
  from auth.users
  where id = caller_id
  for update;

  if not found
    or caller_is_anonymous is true
    or caller_email is null
    or caller_email_confirmed_at is null
    or not caller_has_email_provider
    or caller_has_phone_provider
  then
    raise exception 'A verified permanent account is required'
      using errcode = '42501';
  end if;

  perform 1
  from auth.sessions
  where id = caller_session_id
    and user_id = caller_id
    and (not_after is null or not_after > clock_timestamp())
  for update;
  if not found then
    raise exception 'A current account session is required'
      using errcode = '42501';
  end if;

  select *
  into existing_token
  from private.account_delete_tokens
  where user_id = caller_id
  for update;

  if found and existing_token.expires_at > clock_timestamp() then
    if existing_token.token_hash = extensions.digest(p_token, 'sha256')
      and existing_token.source_session_id = caller_session_id
      and existing_token.email_hash
        = extensions.digest(lower(btrim(caller_email)), 'sha256')
    then
      return existing_token.expires_at;
    end if;

    raise exception 'Another account deletion verification is in progress'
      using errcode = '55000';
  end if;

  if found then
    delete from private.account_delete_tokens
    where token_hash = existing_token.token_hash;
  end if;

  insert into private.account_delete_tokens (
    token_hash,
    user_id,
    source_session_id,
    email_hash,
    created_at,
    expires_at
  )
  values (
    extensions.digest(p_token, 'sha256'),
    caller_id,
    caller_session_id,
    extensions.digest(lower(btrim(caller_email)), 'sha256'),
    token_created_at,
    token_expiry
  );

  return token_expiry;
end;
$$;

revoke all on function public.prepare_account_deletion(text)
  from public, anon;
grant execute on function public.prepare_account_deletion(text)
  to authenticated;

create or replace function public.refresh_account_deletion(p_token text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_session_id uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
  caller_is_anonymous boolean;
  refreshed_at timestamptz := clock_timestamp();
  refreshed_expiry timestamptz := refreshed_at + interval '10 minutes';
begin
  if caller_id is null or caller_session_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if p_token is null
    or char_length(p_token) <> 64
    or p_token !~ '^[A-Fa-f0-9]{64}$'
  then
    raise exception 'Invalid account deletion secret' using errcode = '22023';
  end if;

  perform private.lock_owner_mutation_resources(array[caller_id]);

  select is_anonymous
  into caller_is_anonymous
  from auth.users
  where id = caller_id
  for update;
  if not found or caller_is_anonymous is true then
    raise exception 'A current permanent account is required'
      using errcode = '42501';
  end if;

  perform 1
  from auth.sessions
  where id = caller_session_id
    and user_id = caller_id
    and (not_after is null or not_after > clock_timestamp())
  for update;
  if not found then
    raise exception 'A current account session is required'
      using errcode = '42501';
  end if;

  update private.account_delete_tokens
  set
    created_at = refreshed_at,
    expires_at = refreshed_expiry
  where user_id = caller_id
    and source_session_id = caller_session_id
    and token_hash = extensions.digest(p_token, 'sha256')
    and expires_at > clock_timestamp();

  if not found then
    raise exception 'Account deletion verification is invalid or expired'
      using errcode = '42501';
  end if;

  return refreshed_expiry;
end;
$$;

revoke all on function public.refresh_account_deletion(text)
  from public, anon;
grant execute on function public.refresh_account_deletion(text)
  to authenticated;

-- Cancellation is deliberately bound to the exact session that prepared the
-- request. Possessing another session for the same user is not sufficient.
create or replace function public.cancel_account_merge(p_token text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_session_id uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
  token_digest bytea;
  hint_state text;
  hint_source_user_id uuid;
  hint_source_session_id uuid;
  hint_target_email_hash bytea;
  hint_created_at timestamptz;
  selected_token private.account_merge_tokens;
  caller_email text;
  caller_is_anonymous boolean;
  caller_has_email_provider boolean;
  caller_has_phone_provider boolean;
  source_session_authorized boolean := false;
  target_session_authorized boolean := false;
  deleted_rows bigint := 0;
begin
  if caller_id is null or caller_session_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if p_token is null
    or char_length(p_token) <> 64
    or p_token !~ '^[A-Fa-f0-9]{64}$'
  then
    raise exception 'Invalid account merge secret' using errcode = '22023';
  end if;

  token_digest := extensions.digest(p_token, 'sha256');

  select
    merge_state,
    source_user_id,
    source_session_id,
    target_email_hash,
    created_at
  into
    hint_state,
    hint_source_user_id,
    hint_source_session_id,
    hint_target_email_hash,
    hint_created_at
  from private.account_merge_tokens
  where token_hash = token_digest;

  -- An already-absent bearer is safely cancelled. A consumed receipt still
  -- exists and deliberately returns false so the client keeps it for recovery.
  if not found then
    return true;
  end if;
  if hint_state <> 'prepared' then
    return false;
  end if;

  perform private.lock_owner_mutation_resources(
    array[caller_id, hint_source_user_id]
  );

  perform 1
  from auth.users
  where id = any(array[caller_id, hint_source_user_id]::uuid[])
  order by id::text
  for update;

  perform 1
  from auth.sessions
  where id = any(array[caller_session_id, hint_source_session_id]::uuid[])
  order by id::text
  for update;

  select
    email,
    is_anonymous,
    coalesce(raw_app_meta_data->>'provider' = 'email', false)
      or coalesce(raw_app_meta_data->'providers' ? 'email', false),
    coalesce(raw_app_meta_data->>'provider' = 'phone', false)
      or coalesce(raw_app_meta_data->'providers' ? 'phone', false)
      or nullif(btrim(coalesce(phone, '')), '') is not null
  into
    caller_email,
    caller_is_anonymous,
    caller_has_email_provider,
    caller_has_phone_provider
  from auth.users
  where id = caller_id;
  if not found or not exists (
    select 1
    from auth.sessions
    where id = caller_session_id
      and user_id = caller_id
      and (not_after is null or not_after > clock_timestamp())
  ) then
    raise exception 'A current account session is required'
      using errcode = '42501';
  end if;

  select *
  into selected_token
  from private.account_merge_tokens
  where token_hash = token_digest
  for update;

  if not found then
    return true;
  end if;
  if selected_token.merge_state <> 'prepared' then
    return false;
  end if;
  if selected_token.source_user_id is distinct from hint_source_user_id
    or selected_token.source_session_id
      is distinct from hint_source_session_id
    or selected_token.target_email_hash
      is distinct from hint_target_email_hash
    or selected_token.created_at is distinct from hint_created_at
  then
    return false;
  end if;

  source_session_authorized :=
    selected_token.source_user_id = caller_id
    and selected_token.source_session_id = caller_session_id;

  target_session_authorized :=
    caller_is_anonymous is false
    and caller_has_email_provider
    and not caller_has_phone_provider
    and caller_email is not null
    and selected_token.target_email_hash
      = extensions.digest(lower(btrim(caller_email)), 'sha256')
    and caller_session_id <> selected_token.source_session_id
    and exists (
      select 1
      from auth.sessions
      where id = caller_session_id
        and user_id = caller_id
        and created_at >= selected_token.created_at - interval '5 seconds'
        and (not_after is null or not_after > clock_timestamp())
    )
    and private.jwt_has_email_otp_since(selected_token.created_at);

  if not source_session_authorized and not target_session_authorized then
    return false;
  end if;

  delete from private.account_merge_tokens
  where token_hash = selected_token.token_hash
    and merge_state = 'prepared'
    and source_user_id = selected_token.source_user_id
    and source_session_id = selected_token.source_session_id;
  get diagnostics deleted_rows = row_count;

  return deleted_rows = 1;
end;
$$;

revoke all on function public.cancel_account_merge(text) from public, anon;
grant execute on function public.cancel_account_merge(text) to authenticated;

create or replace function public.cancel_account_deletion(p_token text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_session_id uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
  token_digest bytea;
  hint_user_id uuid;
  hint_source_session_id uuid;
  hint_email_hash bytea;
  hint_created_at timestamptz;
  selected_token private.account_delete_tokens;
  caller_email text;
  caller_is_anonymous boolean;
  caller_has_email_provider boolean;
  caller_has_phone_provider boolean;
  cancellation_authorized boolean := false;
  deleted_rows bigint := 0;
begin
  if caller_id is null or caller_session_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if p_token is null
    or char_length(p_token) <> 64
    or p_token !~ '^[A-Fa-f0-9]{64}$'
  then
    raise exception 'Invalid account deletion secret' using errcode = '22023';
  end if;

  token_digest := extensions.digest(p_token, 'sha256');

  select user_id, source_session_id, email_hash, created_at
  into
    hint_user_id,
    hint_source_session_id,
    hint_email_hash,
    hint_created_at
  from private.account_delete_tokens
  where token_hash = token_digest;

  if not found then
    return true;
  end if;

  perform private.lock_owner_mutation_resources(
    array[caller_id, hint_user_id]
  );

  perform 1
  from auth.users
  where id = any(array[caller_id, hint_user_id]::uuid[])
  order by id::text
  for update;

  perform 1
  from auth.sessions
  where id = any(array[caller_session_id, hint_source_session_id]::uuid[])
  order by id::text
  for update;

  select
    email,
    is_anonymous,
    coalesce(raw_app_meta_data->>'provider' = 'email', false)
      or coalesce(raw_app_meta_data->'providers' ? 'email', false),
    coalesce(raw_app_meta_data->>'provider' = 'phone', false)
      or coalesce(raw_app_meta_data->'providers' ? 'phone', false)
      or nullif(btrim(coalesce(phone, '')), '') is not null
  into
    caller_email,
    caller_is_anonymous,
    caller_has_email_provider,
    caller_has_phone_provider
  from auth.users
  where id = caller_id;
  if not found or not exists (
    select 1
    from auth.sessions
    where id = caller_session_id
      and user_id = caller_id
      and (not_after is null or not_after > clock_timestamp())
  ) then
    raise exception 'A current account session is required'
      using errcode = '42501';
  end if;

  select *
  into selected_token
  from private.account_delete_tokens
  where token_hash = token_digest
  for update;

  if not found then
    return true;
  end if;
  if selected_token.user_id is distinct from hint_user_id
    or selected_token.source_session_id
      is distinct from hint_source_session_id
    or selected_token.email_hash is distinct from hint_email_hash
    or selected_token.created_at is distinct from hint_created_at
  then
    return false;
  end if;

  cancellation_authorized :=
    selected_token.user_id = caller_id
    and (
      selected_token.source_session_id = caller_session_id
      or (
        caller_is_anonymous is false
        and caller_has_email_provider
        and not caller_has_phone_provider
        and caller_email is not null
        and selected_token.email_hash
          = extensions.digest(lower(btrim(caller_email)), 'sha256')
        and exists (
          select 1
          from auth.sessions
          where id = caller_session_id
            and user_id = caller_id
            and created_at >= selected_token.created_at - interval '5 seconds'
            and (not_after is null or not_after > clock_timestamp())
        )
        and private.jwt_has_email_otp_since(selected_token.created_at)
      )
    );

  if not cancellation_authorized then
    return false;
  end if;

  delete from private.account_delete_tokens
  where token_hash = selected_token.token_hash
    and user_id = caller_id
    and source_session_id = selected_token.source_session_id;
  get diagnostics deleted_rows = row_count;

  return deleted_rows = 1;
end;
$$;

revoke all on function public.cancel_account_deletion(text) from public, anon;
grant execute on function public.cancel_account_deletion(text) to authenticated;

-- Every auth identity owns an activity row from the transaction that creates
-- it. This removes the missing-row UPSERT race between normal activity touches
-- and an account transition holding auth.users FOR UPDATE.
create or replace function private.initialize_user_activity_from_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.user_activity (user_id, last_active_at, created_at)
  values (
    new.id,
    greatest(coalesce(new.last_sign_in_at, new.created_at), new.created_at),
    clock_timestamp()
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke all on function private.initialize_user_activity_from_auth_user()
  from public, anon, authenticated;

drop trigger if exists studytrace_initialize_user_activity on auth.users;
create trigger studytrace_initialize_user_activity
after insert on auth.users
for each row execute function private.initialize_user_activity_from_auth_user();

insert into private.user_activity (user_id, last_active_at)
select
  account.id,
  greatest(coalesce(account.last_sign_in_at, account.created_at), account.created_at)
from auth.users as account
on conflict (user_id) do nothing;

create or replace function private.touch_user_activity_from_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_user_id uuid := (to_jsonb(new)->>'user_id')::uuid;
  caller_id uuid := auth.uid();
begin
  if row_user_id is null then
    raise exception 'Activity row must have an owner' using errcode = '23502';
  end if;

  if caller_id is not null and caller_id <> row_user_id then
    raise exception 'Activity ownership does not match the caller (% <> %)',
      caller_id, row_user_id
      using errcode = '42501';
  end if;

  update private.user_activity
  set last_active_at = greatest(last_active_at, clock_timestamp())
  where user_id = row_user_id;

  if not found then
    raise exception 'Activity tracking row is missing'
      using errcode = 'P0002';
  end if;

  return new;
end;
$$;

revoke all on function private.touch_user_activity_from_row()
  from public, anon, authenticated;

create or replace function public.touch_my_activity()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  touched_at timestamptz := clock_timestamp();
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  perform private.lock_owner_mutation_resources(array[caller_id]);

  update private.user_activity
  set last_active_at = greatest(last_active_at, touched_at)
  where user_id = caller_id
  returning last_active_at into touched_at;

  if not found then
    raise exception 'Activity tracking row is missing'
      using errcode = 'P0002';
  end if;

  return touched_at;
end;
$$;

revoke all on function public.touch_my_activity() from public, anon;
grant execute on function public.touch_my_activity() to authenticated;

drop trigger if exists user_settings_lock_owner_resource
  on public.user_settings;

-- PR4 replaces only this hook to append insight-owner advisory locks. Keeping
-- the core lock function below stable prevents a later migration from dropping
-- the five business-table and AI-quota locks by accident.
create or replace function private.lock_account_flow_extension_resources(
  p_ordered_user_ids uuid[]
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  -- Deliberate PR3 no-op extension point.
  perform p_ordered_user_ids;
  return;
end;
$$;

revoke all on function private.lock_account_flow_extension_resources(uuid[])
  from public, anon, authenticated;

-- Use the same advisory keys as normal row/AI quota writers. Every destructive
-- account operation acquires this complete, deterministic resource set before
-- taking auth.users row locks, so an FK check can never form the opposite half
-- of an advisory/user-row deadlock. IDs are null-filtered, deduplicated, and
-- sorted by their canonical UUID text before any lock is taken.
create or replace function private.lock_account_flow_resources(
  p_user_ids uuid[],
  p_merge_target_user_id uuid default null
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  business_table text;
  resource_user_id uuid;
  ordered_user_ids uuid[];
begin
  select coalesce(
    array_agg(candidate.user_id order by candidate.user_id::text),
    '{}'::uuid[]
  )
  into ordered_user_ids
  from (
    select distinct raw_user_id as user_id
    from unnest(p_user_ids) as supplied(raw_user_id)
    where raw_user_id is not null
  ) as candidate;

  if cardinality(ordered_user_ids) = 0 then
    raise exception 'At least one account resource is required'
      using errcode = '22023';
  end if;

  perform private.lock_owner_mutation_resources(ordered_user_ids);

  if p_merge_target_user_id is not null then
    if not p_merge_target_user_id = any(ordered_user_ids) then
      raise exception 'Merge target must be included in account resources'
        using errcode = '22023';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'studytrace.account_merge_target:'
          || p_merge_target_user_id::text,
        0
      )
    );
  end if;

  -- Extension locks are first because PR4 fact/task triggers acquire their
  -- insight-owner key before the core per-table quota key.
  perform private.lock_account_flow_extension_resources(ordered_user_ids);

  foreach business_table in array array[
    'tasks',
    'study_sessions',
    'behavior_events',
    'reminder_events',
    'reviews'
  ] loop
    foreach resource_user_id in array ordered_user_ids loop
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'public.' || business_table || ':' || resource_user_id::text,
          0
        )
      );
    end loop;
  end loop;

  foreach resource_user_id in array ordered_user_ids loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'studytrace.ai_generation_quota:' || resource_user_id::text,
        0
      )
    );
  end loop;

  perform private.lock_account_settings_resources(ordered_user_ids);

end;
$$;

revoke all on function private.lock_account_flow_resources(uuid[], uuid)
  from public, anon, authenticated;

create or replace function private.assert_account_merge_capacity(
  p_source_user_id uuid,
  p_target_user_id uuid
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  business_tables constant text[] := array[
    'tasks',
    'study_sessions',
    'behavior_events',
    'reminder_events',
    'reviews'
  ];
  table_limits constant bigint[] := array[200, 1000, 5000, 5000, 1000];
  combined_rows bigint;
begin
  for table_index in 1..array_length(business_tables, 1) loop
    execute pg_catalog.format(
      'select count(*) from public.%I where user_id in ($1, $2)',
      business_tables[table_index]
    )
    into combined_rows
    using p_source_user_id, p_target_user_id;

    if combined_rows > table_limits[table_index] then
      raise exception 'Account merge would exceed the data limit for % (% > %)',
        business_tables[table_index],
        combined_rows,
        table_limits[table_index]
        using errcode = '54000';
    end if;
  end loop;
end;
$$;

revoke all on function private.assert_account_merge_capacity(uuid, uuid)
  from public, anon, authenticated;

-- PR4 replaces only this final-capacity hook after adding its fact tables. It
-- runs while every core and extension advisory resource lock is already held.
create or replace function private.assert_account_merge_extension_capacity(
  p_source_user_id uuid,
  p_target_user_id uuid
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  -- Deliberate PR3 no-op extension point.
  perform p_source_user_id, p_target_user_id;
  return;
end;
$$;

revoke all on function private.assert_account_merge_extension_capacity(
  uuid,
  uuid
) from public, anon, authenticated;

-- PR4 replaces this hook to move private coverage rows that are not reachable
-- through a public parent row. It runs inside the same merge transaction after
-- all capacity checks and before any core ownership mutation.
create or replace function private.apply_account_merge_extension(
  p_source_user_id uuid,
  p_target_user_id uuid
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  -- Deliberate PR3 no-op extension point.
  perform p_source_user_id, p_target_user_id;
  return;
end;
$$;

revoke all on function private.apply_account_merge_extension(uuid, uuid)
  from public, anon, authenticated;

create or replace function private.merge_ai_generation_quota(
  p_source_user_id uuid,
  p_target_user_id uuid,
  p_quota_now timestamptz
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  source_quota private.ai_generation_quota%rowtype;
  target_quota private.ai_generation_quota%rowtype;
  source_exists boolean;
  target_exists boolean;
  merged_window_started_at timestamptz;
  merged_attempts integer;
begin
  select *
  into source_quota
  from private.ai_generation_quota
  where user_id = p_source_user_id
  for update;
  source_exists := found;

  select *
  into target_quota
  from private.ai_generation_quota
  where user_id = p_target_user_id
  for update;
  target_exists := found;

  if not source_exists then
    return;
  end if;

  if not target_exists then
    update private.ai_generation_quota
    set user_id = p_target_user_id
    where user_id = p_source_user_id;
    return;
  end if;

  if source_quota.window_started_at > p_quota_now - interval '10 minutes'
    and target_quota.window_started_at > p_quota_now - interval '10 minutes'
  then
    merged_window_started_at := greatest(
      source_quota.window_started_at,
      target_quota.window_started_at
    );
    merged_attempts := least(
      2147483647::bigint,
      source_quota.attempts::bigint + target_quota.attempts::bigint
    )::integer;
  elsif source_quota.window_started_at > target_quota.window_started_at then
    merged_window_started_at := source_quota.window_started_at;
    merged_attempts := source_quota.attempts;
  elsif target_quota.window_started_at > source_quota.window_started_at then
    merged_window_started_at := target_quota.window_started_at;
    merged_attempts := target_quota.attempts;
  else
    merged_window_started_at := target_quota.window_started_at;
    merged_attempts := greatest(
      source_quota.attempts,
      target_quota.attempts
    );
  end if;

  update private.ai_generation_quota
  set
    window_started_at = merged_window_started_at,
    attempts = merged_attempts
  where user_id = p_target_user_id;

  delete from private.ai_generation_quota
  where user_id = p_source_user_id;
end;
$$;

revoke all on function private.merge_ai_generation_quota(
  uuid,
  uuid,
  timestamptz
) from public, anon, authenticated;

-- Coordinate normal quota consumption with account transfer. Without this
-- lock, a first request for an identity with no quota row could race a merge.
create or replace function public.consume_ai_generation_quota()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  quota_now timestamptz := clock_timestamp();
  current_quota_date date := (quota_now at time zone 'UTC')::date;
  user_allowed boolean;
  global_allowed boolean;
begin
  if current_user_id is null then
    raise exception 'Anonymous experience is not ready' using errcode = '42501';
  end if;

  perform private.lock_owner_mutation_resources(array[current_user_id]);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'studytrace.ai_generation_quota:' || current_user_id::text,
      0
    )
  );

  insert into private.ai_generation_quota (
    user_id,
    window_started_at,
    attempts
  )
  values (current_user_id, quota_now, 1)
  on conflict (user_id) do update
  set
    window_started_at = case
      when private.ai_generation_quota.window_started_at
        <= quota_now - interval '10 minutes'
        then quota_now
      else private.ai_generation_quota.window_started_at
    end,
    attempts = case
      when private.ai_generation_quota.window_started_at
        <= quota_now - interval '10 minutes'
        then 1
      else private.ai_generation_quota.attempts + 1
    end
  returning attempts <= 8 into user_allowed;

  if not user_allowed then
    return false;
  end if;

  insert into private.ai_global_daily_quota (quota_date, attempts)
  values (current_quota_date, 1)
  on conflict (quota_date) do update
  set attempts = private.ai_global_daily_quota.attempts + 1
  returning attempts <= 200 into global_allowed;

  delete from private.ai_global_daily_quota
  where quota_date < current_quota_date - 35;

  return global_allowed;
end;
$$;

revoke all on function public.consume_ai_generation_quota()
  from public, anon;
grant execute on function public.consume_ai_generation_quota()
  to authenticated;

create or replace function public.consume_account_merge(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_target_user_id uuid := auth.uid();
  caller_target_session_id uuid := nullif(
    auth.jwt()->>'session_id',
    ''
  )::uuid;
  token_digest bytea;
  hint_state text;
  hint_source_user_id uuid;
  hint_source_session_id uuid;
  hint_target_user_id uuid;
  hint_target_session_id uuid;
  hint_target_email_hash bytea;
  hint_created_at timestamptz;
  hint_expires_at timestamptz;
  selected_token private.account_merge_tokens;
  target_email text;
  target_is_anonymous boolean;
  target_email_confirmed_at timestamptz;
  target_has_email_provider boolean;
  target_has_phone_provider boolean;
  source_is_anonymous boolean;
  source_last_active_at timestamptz;
  merge_consumed_at timestamptz;
  merge_receipt jsonb;
  moved_tasks bigint;
  moved_sessions bigint;
  moved_behavior_events bigint;
  moved_reminders bigint;
  moved_reviews bigint;
begin
  if caller_target_user_id is null or caller_target_session_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if p_token is null
    or char_length(p_token) <> 64
    or p_token !~ '^[A-Fa-f0-9]{64}$'
  then
    raise exception 'Invalid account merge secret' using errcode = '22023';
  end if;

  token_digest := extensions.digest(p_token, 'sha256');

  -- This first read is only a lock-order hint. All values are re-read and
  -- validated after user/session locks and the token row lock are held.
  select
    merge_state,
    source_user_id,
    source_session_id,
    target_user_id,
    target_session_id,
    target_email_hash,
    created_at,
    expires_at
  into
    hint_state,
    hint_source_user_id,
    hint_source_session_id,
    hint_target_user_id,
    hint_target_session_id,
    hint_target_email_hash,
    hint_created_at,
    hint_expires_at
  from private.account_merge_tokens
  where token_hash = token_digest;

  if not found then
    raise exception 'Account merge request is invalid or expired'
      using errcode = '42501';
  end if;

  -- Row-quota triggers and normal AI quota consumption take these advisory
  -- locks before PostgreSQL checks their auth.users foreign keys. Follow the
  -- same direction here, then lock user/session/token rows. The token is
  -- strictly re-read below because this hint was intentionally lock-free.
  if hint_state = 'prepared' and hint_source_user_id is not null then
    perform private.lock_owner_mutation_resources(
      array[hint_source_user_id, caller_target_user_id]
    );
    perform private.lock_account_flow_resources(
      array[hint_source_user_id, caller_target_user_id],
      caller_target_user_id
    );
  else
    perform private.lock_owner_mutation_resources(
      array[caller_target_user_id, hint_target_user_id]
    );
  end if;

  -- Account-flow row locks remain user -> session -> token. UUID ordering keeps
  -- two merges into one target from deadlocking each other.
  perform 1
  from auth.users
  where id = any(array[
    caller_target_user_id,
    hint_source_user_id,
    hint_target_user_id
  ]::uuid[])
  order by id
  for update;

  perform 1
  from auth.sessions
  where id = any(array[
    caller_target_session_id,
    hint_source_session_id,
    hint_target_session_id
  ]::uuid[])
  order by id
  for update;

  select *
  into selected_token
  from private.account_merge_tokens
  where token_hash = token_digest
  for update;

  if not found then
    raise exception 'Account merge request is invalid or expired'
      using errcode = '42501';
  end if;

  select
    email,
    is_anonymous,
    email_confirmed_at,
    coalesce(raw_app_meta_data->>'provider' = 'email', false)
      or coalesce(raw_app_meta_data->'providers' ? 'email', false),
    coalesce(raw_app_meta_data->>'provider' = 'phone', false)
      or coalesce(raw_app_meta_data->'providers' ? 'phone', false)
      or nullif(btrim(coalesce(phone, '')), '') is not null
  into
    target_email,
    target_is_anonymous,
    target_email_confirmed_at,
    target_has_email_provider,
    target_has_phone_provider
  from auth.users
  where id = caller_target_user_id;

  if not found
    or target_is_anonymous is true
    or target_email is null
    or target_email_confirmed_at is null
    or not target_has_email_provider
    or target_has_phone_provider
    or not exists (
      select 1
      from auth.sessions
      where id = caller_target_session_id
        and user_id = caller_target_user_id
        and (not_after is null or not_after > clock_timestamp())
    )
  then
    raise exception 'A verified permanent account is required'
      using errcode = '42501';
  end if;

  -- A committed merge can be acknowledged again only to the same exact target
  -- session for thirty minutes. No OTP, ownership update, or TTL extension runs.
  if selected_token.merge_state = 'consumed' then
    if selected_token.expires_at <= clock_timestamp()
      or selected_token.target_user_id <> caller_target_user_id
      or selected_token.target_session_id <> caller_target_session_id
      or selected_token.consume_receipt is null
    then
      raise exception 'Account merge request is invalid or expired'
        using errcode = '42501';
    end if;

    return selected_token.consume_receipt;
  end if;

  if selected_token.merge_state <> 'prepared'
    or selected_token.source_user_id is null
    or selected_token.source_session_id is null
    or selected_token.expires_at <= clock_timestamp()
    or selected_token.target_email_hash
      <> extensions.digest(lower(btrim(target_email)), 'sha256')
  then
    raise exception 'Account merge request is invalid or expired'
      using errcode = '42501';
  end if;

  -- If the hint row was canceled and an astronomically unlikely token hash was
  -- reused before this transaction acquired its lock, retry with fresh locks.
  if hint_state <> 'prepared'
    or hint_source_user_id is distinct from selected_token.source_user_id
    or hint_source_session_id is distinct from selected_token.source_session_id
    or hint_target_user_id is distinct from selected_token.target_user_id
    or hint_target_session_id is distinct from selected_token.target_session_id
    or hint_target_email_hash is distinct from selected_token.target_email_hash
    or hint_created_at is distinct from selected_token.created_at
    or hint_expires_at is distinct from selected_token.expires_at
  then
    raise exception 'Account merge request changed; retry'
      using errcode = '40001';
  end if;

  if selected_token.source_user_id = caller_target_user_id then
    raise exception 'Source and target accounts must be different'
      using errcode = '22023';
  end if;

  if caller_target_session_id = selected_token.source_session_id
    or not exists (
      select 1
      from auth.sessions
      where id = caller_target_session_id
        and user_id = caller_target_user_id
        and created_at >= selected_token.created_at - interval '5 seconds'
        and (not_after is null or not_after > clock_timestamp())
    )
    or not private.jwt_has_email_otp_since(selected_token.created_at)
  then
    raise exception 'A fresh email OTP verification is required'
      using errcode = '42501';
  end if;

  select is_anonymous
  into source_is_anonymous
  from auth.users
  where id = selected_token.source_user_id;

  if not found or source_is_anonymous is not true then
    raise exception 'Anonymous source account no longer exists'
      using errcode = 'P0002';
  end if;

  if exists (
    select 1
    from public.study_sessions
    where user_id = selected_token.source_user_id
      and status in ('running', 'paused')
  ) then
    raise exception 'Anonymous source still has an active study session'
      using errcode = '55000';
  end if;

  perform private.assert_account_merge_capacity(
    selected_token.source_user_id,
    caller_target_user_id
  );
  perform private.assert_account_merge_extension_capacity(
    selected_token.source_user_id,
    caller_target_user_id
  );

  perform set_config(
    'studytrace.account_merge_source',
    selected_token.source_user_id::text,
    true
  );
  perform set_config(
    'studytrace.account_merge_target',
    caller_target_user_id::text,
    true
  );

  -- The extension hook may update rows that use trusted owner-transition
  -- triggers. Set the transaction-local proof before invoking it, while still
  -- running it ahead of every core settings/data ownership mutation.
  perform private.apply_account_merge_extension(
    selected_token.source_user_id,
    caller_target_user_id
  );

  if exists (
    select 1
    from public.user_settings
    where user_id = caller_target_user_id
  ) then
    delete from public.user_settings
    where user_id = selected_token.source_user_id;
  else
    update public.user_settings
    set user_id = caller_target_user_id
    where user_id = selected_token.source_user_id;
  end if;

  update public.tasks
  set user_id = caller_target_user_id
  where user_id = selected_token.source_user_id;
  get diagnostics moved_tasks = row_count;

  update public.study_sessions
  set user_id = caller_target_user_id
  where user_id = selected_token.source_user_id;
  get diagnostics moved_sessions = row_count;

  update public.behavior_events
  set user_id = caller_target_user_id
  where user_id = selected_token.source_user_id;
  get diagnostics moved_behavior_events = row_count;

  update public.reminder_events
  set user_id = caller_target_user_id
  where user_id = selected_token.source_user_id;
  get diagnostics moved_reminders = row_count;

  update public.reviews
  set user_id = caller_target_user_id
  where user_id = selected_token.source_user_id;
  get diagnostics moved_reviews = row_count;

  merge_consumed_at := clock_timestamp();
  perform private.merge_ai_generation_quota(
    selected_token.source_user_id,
    caller_target_user_id,
    merge_consumed_at
  );

  select last_active_at
  into source_last_active_at
  from private.user_activity
  where user_id = selected_token.source_user_id
  for update;

  if not found then
    raise exception 'Anonymous source activity row is missing'
      using errcode = 'P0002';
  end if;

  update private.user_activity
  set last_active_at = greatest(
    last_active_at,
    merge_consumed_at,
    source_last_active_at
  )
  where user_id = caller_target_user_id;

  if not found then
    raise exception 'Target account activity row is missing'
      using errcode = 'P0002';
  end if;

  merge_receipt := jsonb_build_object(
    'tasks', moved_tasks,
    'sessions', moved_sessions,
    'behavior_events', moved_behavior_events,
    'reminder_events', moved_reminders,
    'reviews', moved_reviews
  );

  update private.account_merge_tokens
  set
    merge_state = 'consumed',
    source_user_id = null,
    source_session_id = null,
    target_user_id = caller_target_user_id,
    target_session_id = caller_target_session_id,
    consumed_at = merge_consumed_at,
    consume_receipt = merge_receipt,
    expires_at = merge_consumed_at + interval '30 minutes'
  where token_hash = selected_token.token_hash
    and merge_state = 'prepared'
    and source_user_id = selected_token.source_user_id
    and source_session_id = selected_token.source_session_id;

  if not found then
    raise exception 'Account merge request changed during merge'
      using errcode = '40001';
  end if;

  delete from auth.users
  where id = selected_token.source_user_id
    and is_anonymous is true;

  if not found then
    raise exception 'Anonymous source account changed during merge'
      using errcode = '40001';
  end if;

  return merge_receipt;
end;
$$;

revoke all on function public.consume_account_merge(text)
  from public, anon;
grant execute on function public.consume_account_merge(text)
  to authenticated;

-- Take user/session locks before the deletion token so cancellation, cleanup,
-- and final deletion share one lock order.
create or replace function public.delete_my_account(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_session_id uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
  token_digest bytea;
  hinted_source_session_id uuid;
  selected_token private.account_delete_tokens;
  caller_email text;
  caller_is_anonymous boolean;
  caller_email_confirmed_at timestamptz;
  caller_has_email_provider boolean;
  caller_has_phone_provider boolean;
begin
  if caller_id is null or caller_session_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if p_token is null
    or char_length(p_token) <> 64
    or p_token !~ '^[A-Fa-f0-9]{64}$'
  then
    raise exception 'Invalid account deletion secret' using errcode = '22023';
  end if;

  token_digest := extensions.digest(p_token, 'sha256');
  select source_session_id
  into hinted_source_session_id
  from private.account_delete_tokens
  where token_hash = token_digest;

  if not found then
    raise exception 'Account deletion verification is invalid or expired'
      using errcode = '42501';
  end if;

  perform private.lock_owner_mutation_resources(array[caller_id]);
  perform private.lock_account_flow_resources(array[caller_id]);

  select
    email,
    is_anonymous,
    email_confirmed_at,
    coalesce(raw_app_meta_data->>'provider' = 'email', false)
      or coalesce(raw_app_meta_data->'providers' ? 'email', false),
    coalesce(raw_app_meta_data->>'provider' = 'phone', false)
      or coalesce(raw_app_meta_data->'providers' ? 'phone', false)
      or nullif(btrim(coalesce(phone, '')), '') is not null
  into
    caller_email,
    caller_is_anonymous,
    caller_email_confirmed_at,
    caller_has_email_provider,
    caller_has_phone_provider
  from auth.users
  where id = caller_id
  for update;

  if not found
    or caller_is_anonymous is true
    or caller_email is null
    or caller_email_confirmed_at is null
    or not caller_has_email_provider
    or caller_has_phone_provider
  then
    raise exception 'A verified permanent account is required'
      using errcode = '42501';
  end if;

  perform 1
  from auth.sessions
  where id = any(array[
    caller_session_id,
    hinted_source_session_id
  ]::uuid[])
  order by id
  for update;

  select *
  into selected_token
  from private.account_delete_tokens
  where token_hash = token_digest
  for update;

  if not found
    or selected_token.user_id <> caller_id
    or selected_token.source_session_id
      is distinct from hinted_source_session_id
    or selected_token.expires_at <= clock_timestamp()
    or selected_token.email_hash
      <> extensions.digest(lower(btrim(caller_email)), 'sha256')
  then
    raise exception 'Account deletion verification is invalid or expired'
      using errcode = '42501';
  end if;

  if caller_session_id = selected_token.source_session_id
    or not exists (
      select 1
      from auth.sessions
      where id = caller_session_id
        and user_id = caller_id
        and created_at >= selected_token.created_at - interval '5 seconds'
        and (not_after is null or not_after > clock_timestamp())
    )
    or not private.jwt_has_email_otp_since(selected_token.created_at)
  then
    raise exception 'A fresh deletion email OTP verification is required'
      using errcode = '42501';
  end if;

  delete from private.account_delete_tokens
  where token_hash = selected_token.token_hash;

  -- Sessions are removed first because task deletion is intentionally blocked
  -- while a running or paused study session exists. Remaining rows cascade.
  delete from public.study_sessions where user_id = caller_id;
  delete from auth.users where id = caller_id;

  if not found then
    raise exception 'Account no longer exists' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.delete_my_account(text) from public, anon;
grant execute on function public.delete_my_account(text) to authenticated;

-- Process a bounded, stable batch. The first query is deliberately only a
-- lock-order hint: account-wide advisory resources are acquired before any
-- auth/data row lock, then every candidate is re-read under auth -> activity
-- row locks. Repeated invocations advance through a backlog without a long
-- transaction or the old missing-activity UPSERT race.
create or replace function private.cleanup_expired_anonymous_users()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  hinted_user_ids uuid[];
  expired_user_ids uuid[] := '{}'::uuid[];
  candidate_user_id uuid;
  candidate_is_anonymous boolean;
  candidate_last_active_at timestamptz;
  deleted_count bigint := 0;
begin
  select coalesce(
    array_agg(candidate.id order by candidate.id::text),
    '{}'::uuid[]
  )
  into hinted_user_ids
  from (
    select account.id
    from auth.users as account
    join private.user_activity as activity
      on activity.user_id = account.id
    where account.is_anonymous is true
      and activity.last_active_at
        < clock_timestamp() - interval '30 days'
    order by account.id::text
    limit 50
  ) as candidate;

  if cardinality(hinted_user_ids) > 0 then
    perform private.lock_owner_mutation_resources(hinted_user_ids);
    perform private.lock_account_flow_resources(hinted_user_ids);

    foreach candidate_user_id in array hinted_user_ids loop
      select account.is_anonymous
      into candidate_is_anonymous
      from auth.users as account
      where account.id = candidate_user_id
      for update;

      if not found or candidate_is_anonymous is not true then
        continue;
      end if;

      select activity.last_active_at
      into candidate_last_active_at
      from private.user_activity as activity
      where activity.user_id = candidate_user_id
      for update;

      if found
        and candidate_last_active_at
          < clock_timestamp() - interval '30 days'
      then
        expired_user_ids := array_append(
          expired_user_ids,
          candidate_user_id
        );
      end if;
    end loop;

    if cardinality(expired_user_ids) > 0 then
      delete from public.study_sessions
      where user_id = any(expired_user_ids);

      delete from auth.users
      where id = any(expired_user_ids)
        and is_anonymous is true;

      get diagnostics deleted_count = row_count;
    end if;
  end if;

  delete from private.account_merge_tokens
  where expires_at <= clock_timestamp();

  delete from private.account_delete_tokens
  where expires_at <= clock_timestamp();

  return deleted_count;
end;
$$;

revoke all on function private.cleanup_expired_anonymous_users()
  from public, anon, authenticated;

-- A fifty-user batch once per day can fall behind public anonymous traffic.
-- Safely replace every legacy job with one bounded run every fifteen minutes.
do $account_cleanup_schedule$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid
    from cron.job
    where jobname = 'studytrace-cleanup-expired-anonymous-users'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'studytrace-cleanup-expired-anonymous-users',
    '*/15 * * * *',
    $cleanup$select private.cleanup_expired_anonymous_users();$cleanup$
  );
end;
$account_cleanup_schedule$;

comment on table private.account_merge_tokens is
  'Short-lived hashed merge bearers transitioning atomically from prepared request to target-user-and-session-bound receipt.';
comment on function public.cancel_account_merge(text) is
  'Cancels a prepared merge bearer from its source session or the exact freshly verified target session; consumed receipts remain recoverable.';
comment on function public.cancel_account_deletion(text) is
  'Idempotently cancels a deletion bearer from its source or exact freshly verified replacement session.';
comment on function private.lock_account_flow_resources(uuid[], uuid) is
  'Acquires extension, business, AI, and settings advisory resources before account row locks in deterministic order.';
comment on function private.lock_account_flow_extension_resources(uuid[]) is
  'Stable no-op extension ABI replaced by later migrations to prepend their owner advisory locks.';
comment on function private.assert_account_merge_capacity(uuid, uuid) is
  'Rejects a transfer when source and target data would exceed a per-user table limit.';
comment on function private.assert_account_merge_extension_capacity(
  uuid,
  uuid
) is 'Stable no-op extension ABI for final locked capacity checks.';
comment on function private.apply_account_merge_extension(uuid, uuid) is
  'Stable no-op extension ABI for atomic owner transitions before core mutations.';
comment on function private.merge_ai_generation_quota(
  uuid,
  uuid,
  timestamptz
) is 'Carries source AI usage into the permanent account without resetting its rate limit.';
comment on function public.consume_account_merge(text) is
  'Atomically moves an anonymous identity and leaves a thirty-minute receipt recoverable only by the exact verified target session.';
comment on function private.cleanup_expired_anonymous_users() is
  'Deletes at most fifty anonymous identities inactive for thirty days, then removes expired account-flow requests and receipts.';

notify pgrst, 'reload schema';
