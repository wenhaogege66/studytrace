-- Account continuity for anonymous users.
--
-- Email upgrades keep the existing auth.users id and need no data rewrite.
-- When an email already belongs to a permanent user, the anonymous browser
-- creates a short-lived bearer secret before signing in. Only a SHA-256 hash
-- of that secret and of the intended email are stored. The signed-in target
-- account can consume it exactly once to move the anonymous records.

create extension if not exists pgcrypto with schema extensions;

create table private.user_activity (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_active_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp()
);

create index user_activity_last_active_idx
  on private.user_activity (last_active_at);

alter table private.user_activity enable row level security;
revoke all on table private.user_activity from public, anon, authenticated;

create table private.account_merge_tokens (
  token_hash bytea primary key,
  target_email_hash bytea not null,
  source_user_id uuid not null references auth.users(id) on delete cascade,
  source_session_id uuid not null references auth.sessions(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  constraint account_merge_tokens_short_lived check (
    expires_at > created_at
    and expires_at <= created_at + interval '10 minutes'
  )
);

create unique index account_merge_tokens_one_per_source_idx
  on private.account_merge_tokens (source_user_id);
create index account_merge_tokens_expiry_idx
  on private.account_merge_tokens (expires_at);

alter table private.account_merge_tokens enable row level security;
revoke all on table private.account_merge_tokens
  from public, anon, authenticated;

create table private.account_delete_tokens (
  token_hash bytea primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  source_session_id uuid not null references auth.sessions(id) on delete cascade,
  email_hash bytea not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  constraint account_delete_tokens_short_lived check (
    expires_at > created_at
    and expires_at <= created_at + interval '10 minutes'
  )
);

create unique index account_delete_tokens_one_per_user_idx
  on private.account_delete_tokens (user_id);
create index account_delete_tokens_expiry_idx
  on private.account_delete_tokens (expires_at);

alter table private.account_delete_tokens enable row level security;
revoke all on table private.account_delete_tokens
  from public, anon, authenticated;

-- Existing anonymous users should not lose a month of data simply because the
-- retention rule changed. Seed their activity from the latest durable record
-- we already have, falling back to their latest sign-in or creation time.
insert into private.user_activity (user_id, last_active_at)
select
  account.id,
  greatest(
    coalesce(account.last_sign_in_at, account.created_at),
    coalesce(activity.latest_at, account.created_at)
  )
from auth.users as account
left join lateral (
  select max(candidate.occurred_at) as latest_at
  from (
    select max(task.updated_at) as occurred_at
    from public.tasks as task
    where task.user_id = account.id
    union all
    select max(study_session.updated_at)
    from public.study_sessions as study_session
    where study_session.user_id = account.id
    union all
    select max(event.updated_at)
    from public.behavior_events as event
    where event.user_id = account.id
    union all
    select max(reminder.created_at)
    from public.reminder_events as reminder
    where reminder.user_id = account.id
    union all
    select max(review.updated_at)
    from public.reviews as review
    where review.user_id = account.id
    union all
    select max(settings.updated_at)
    from public.user_settings as settings
    where settings.user_id = account.id
  ) as candidate
) as activity on true
on conflict (user_id) do update
set last_active_at = greatest(
  private.user_activity.last_active_at,
  excluded.last_active_at
);

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

  -- Normal browser writes must only touch their own activity row. A null
  -- auth.uid() is reserved for trusted maintenance and local database tests.
  if caller_id is not null and caller_id <> row_user_id then
    raise exception 'Activity ownership does not match the caller (% <> %)',
      caller_id, row_user_id
      using errcode = '42501';
  end if;

  insert into private.user_activity (user_id, last_active_at)
  values (row_user_id, clock_timestamp())
  on conflict (user_id) do update
  set last_active_at = greatest(
    private.user_activity.last_active_at,
    excluded.last_active_at
  );

  return new;
end;
$$;

revoke all on function private.touch_user_activity_from_row()
  from public, anon, authenticated;

do $$
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
    execute format(
      'drop trigger if exists %I on public.%I',
      business_table || '_touch_user_activity',
      business_table
    );
    execute format(
      'create trigger %I after insert or update on public.%I '
      || 'for each row execute function private.touch_user_activity_from_row()',
      business_table || '_touch_user_activity',
      business_table
    );
  end loop;
end;
$$;

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

  insert into private.user_activity (user_id, last_active_at)
  values (caller_id, touched_at)
  on conflict (user_id) do update
  set last_active_at = greatest(
    private.user_activity.last_active_at,
    excluded.last_active_at
  )
  returning last_active_at into touched_at;

  return touched_at;
end;
$$;

revoke all on function public.touch_my_activity() from public, anon;
grant execute on function public.touch_my_activity() to authenticated;

create or replace function public.get_my_account_transfer_summary()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'tasks', (
      select count(*) from public.tasks where user_id = caller_id
    ),
    'sessions', (
      select count(*) from public.study_sessions where user_id = caller_id
    ),
    'behavior_events', (
      select count(*) from public.behavior_events where user_id = caller_id
    ),
    'reviews', (
      select count(*) from public.reviews where user_id = caller_id
    ),
    'has_active_session', exists (
      select 1
      from public.study_sessions
      where user_id = caller_id
        and status in ('running', 'paused')
    )
  );
end;
$$;

revoke all on function public.get_my_account_transfer_summary()
  from public, anon;
grant execute on function public.get_my_account_transfer_summary()
  to authenticated;

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
  if caller_id is null then
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

  select is_anonymous
  into caller_is_anonymous
  from auth.users
  where id = caller_id
  for update;

  if not found or caller_is_anonymous is not true then
    raise exception 'Only an anonymous account can prepare a merge'
      using errcode = '42501';
  end if;

  if caller_session_id is null or not exists (
    select 1
    from auth.sessions
    where id = caller_session_id
      and user_id = caller_id
      and (not_after is null or not_after > clock_timestamp())
  ) then
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

  select *
  into existing_token
  from private.account_merge_tokens
  where source_user_id = caller_id
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
    where source_user_id = caller_id;
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
    raise exception 'Invalid account merge secret' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from auth.users
    where id = caller_id
      and is_anonymous is true
    for update
  ) or not exists (
    select 1
    from auth.sessions
    where id = caller_session_id
      and user_id = caller_id
      and (not_after is null or not_after > clock_timestamp())
  ) then
    raise exception 'A current anonymous session is required'
      using errcode = '42501';
  end if;

  update private.account_merge_tokens
  set
    created_at = refreshed_at,
    expires_at = refreshed_expiry
  where source_user_id = caller_id
    and source_session_id = caller_session_id
    and token_hash = extensions.digest(p_token, 'sha256')
    and expires_at > clock_timestamp();

  if not found then
    raise exception 'Account merge request is invalid or expired'
      using errcode = '42501';
  end if;

  return refreshed_expiry;
end;
$$;

revoke all on function public.refresh_account_merge(text)
  from public, anon;
grant execute on function public.refresh_account_merge(text)
  to authenticated;

-- These ownership guards remain strict for every normal write. The only
-- exception is a user_id-only change made inside consume_account_merge(),
-- which sets transaction-local source and target ids before moving rows.
create or replace function private.keep_terminal_study_session_immutable()
returns trigger
language plpgsql
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
  is_controlled_owner_change boolean :=
    merge_source = old.user_id::text
    and merge_target = new.user_id::text
    and new.user_id is distinct from old.user_id
    and (to_jsonb(new) - 'user_id' - 'updated_at')
      = (to_jsonb(old) - 'user_id' - 'updated_at');
begin
  if old.status in ('completed', 'cancelled')
    and not is_controlled_owner_change
  then
    raise exception 'A completed or cancelled study session cannot be changed'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function private.keep_terminal_study_session_immutable()
  from public, anon, authenticated;

create or replace function private.normalize_behavior_event_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent_status text;
  parent_ended_at timestamptz;
  database_now timestamptz := clock_timestamp();
  authoritative_end timestamptz;
  merge_source text := current_setting(
    'studytrace.account_merge_source',
    true
  );
  merge_target text := current_setting(
    'studytrace.account_merge_target',
    true
  );
  is_controlled_owner_change boolean :=
    merge_source = old.user_id::text
    and merge_target = new.user_id::text
    and new.user_id is distinct from old.user_id
    and (to_jsonb(new) - 'user_id' - 'updated_at')
      = (to_jsonb(old) - 'user_id' - 'updated_at');
begin
  if is_controlled_owner_change then
    return new;
  end if;

  if new.id is distinct from old.id
    or new.user_id is distinct from old.user_id
    or new.session_id is distinct from old.session_id
  then
    raise exception 'Behavior event identity and ownership are immutable'
      using errcode = '23514';
  end if;

  select status, ended_at
  into parent_status, parent_ended_at
  from public.study_sessions
  where id = old.session_id
    and user_id = old.user_id;

  if not found then
    raise exception 'Linked study session not found' using errcode = 'P0002';
  end if;

  new.event_type := old.event_type;
  new.direction := old.direction;
  new.source := old.source;
  new.created_at := old.created_at;

  if parent_status in ('completed', 'cancelled') then
    authoritative_end := coalesce(parent_ended_at, database_now);
    new.started_at := least(old.started_at, authoritative_end);
    new.ended_at := case
      when old.ended_at is null then authoritative_end
      else least(
        greatest(old.ended_at, new.started_at),
        authoritative_end
      )
    end;
  else
    new.started_at := old.started_at;
    if old.ended_at is not null then
      new.ended_at := old.ended_at;
    elsif new.ended_at is not null then
      new.ended_at := least(
        greatest(new.ended_at, old.started_at),
        database_now
      );
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.normalize_behavior_event_update()
  from public, anon, authenticated;

create or replace function private.jwt_has_email_otp_since(
  p_since timestamptz
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from jsonb_array_elements(
      case
        when jsonb_typeof(auth.jwt()->'amr') = 'array' then auth.jwt()->'amr'
        else '[]'::jsonb
      end
    ) as method(value)
    where method.value->>'method' = 'otp'
      and method.value->>'timestamp' ~ '^[0-9]+$'
      and to_timestamp((method.value->>'timestamp')::double precision)
        >= p_since - interval '5 seconds'
  );
$$;

revoke all on function private.jwt_has_email_otp_since(timestamptz)
  from public, anon, authenticated;

create or replace function public.consume_account_merge(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_user_id uuid := auth.uid();
  target_email text;
  target_is_anonymous boolean;
  target_email_confirmed_at timestamptz;
  target_session_id uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
  selected_token private.account_merge_tokens;
  source_is_anonymous boolean;
  moved_tasks bigint;
  moved_sessions bigint;
  moved_behavior_events bigint;
  moved_reminders bigint;
  moved_reviews bigint;
begin
  if target_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if p_token is null
    or char_length(p_token) <> 64
    or p_token !~ '^[A-Fa-f0-9]{64}$'
  then
    raise exception 'Invalid account merge secret' using errcode = '22023';
  end if;

  select email, is_anonymous, email_confirmed_at
  into target_email, target_is_anonymous, target_email_confirmed_at
  from auth.users
  where id = target_user_id
  for update;

  if not found
    or target_is_anonymous is true
    or target_email is null
    or target_email_confirmed_at is null
  then
    raise exception 'A verified permanent account is required'
      using errcode = '42501';
  end if;

  select *
  into selected_token
  from private.account_merge_tokens
  where token_hash = extensions.digest(p_token, 'sha256')
  for update;

  if not found
    or selected_token.expires_at <= clock_timestamp()
    or selected_token.target_email_hash
      <> extensions.digest(lower(btrim(target_email)), 'sha256')
  then
    raise exception 'Account merge request is invalid or expired'
      using errcode = '42501';
  end if;

  if target_session_id is null
    or target_session_id = selected_token.source_session_id
    or not exists (
      select 1
      from auth.sessions
      where id = target_session_id
        and user_id = target_user_id
        and created_at >= selected_token.created_at - interval '5 seconds'
        and (not_after is null or not_after > clock_timestamp())
    )
    or not private.jwt_has_email_otp_since(selected_token.created_at)
  then
    raise exception 'A fresh email OTP verification is required'
      using errcode = '42501';
  end if;

  if selected_token.source_user_id = target_user_id then
    raise exception 'Source and target accounts must be different'
      using errcode = '22023';
  end if;

  select is_anonymous
  into source_is_anonymous
  from auth.users
  where id = selected_token.source_user_id
  for update;

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

  perform set_config(
    'studytrace.account_merge_source',
    selected_token.source_user_id::text,
    true
  );
  perform set_config(
    'studytrace.account_merge_target',
    target_user_id::text,
    true
  );

  -- Keep the permanent account's settings when present. If an older permanent
  -- account is missing its row, preserve the anonymous user's configured
  -- preferences instead of replacing them with defaults after the merge.
  if exists (
    select 1 from public.user_settings where user_id = target_user_id
  ) then
    delete from public.user_settings
    where user_id = selected_token.source_user_id;
  else
    update public.user_settings
    set user_id = target_user_id
    where user_id = selected_token.source_user_id;
  end if;

  -- Business rows retain their ids so review/session links and bookmarked
  -- routes stay valid.

  update public.tasks
  set user_id = target_user_id
  where user_id = selected_token.source_user_id;
  get diagnostics moved_tasks = row_count;

  update public.study_sessions
  set user_id = target_user_id
  where user_id = selected_token.source_user_id;
  get diagnostics moved_sessions = row_count;

  update public.behavior_events
  set user_id = target_user_id
  where user_id = selected_token.source_user_id;
  get diagnostics moved_behavior_events = row_count;

  update public.reminder_events
  set user_id = target_user_id
  where user_id = selected_token.source_user_id;
  get diagnostics moved_reminders = row_count;

  update public.reviews
  set user_id = target_user_id
  where user_id = selected_token.source_user_id;
  get diagnostics moved_reviews = row_count;

  delete from private.ai_generation_quota
  where user_id = selected_token.source_user_id;

  insert into private.user_activity (user_id, last_active_at)
  values (target_user_id, clock_timestamp())
  on conflict (user_id) do update
  set last_active_at = greatest(
    private.user_activity.last_active_at,
    excluded.last_active_at,
    coalesce(
      (
        select source_activity.last_active_at
        from private.user_activity as source_activity
        where source_activity.user_id = selected_token.source_user_id
      ),
      '-infinity'::timestamptz
    )
  );

  delete from auth.users
  where id = selected_token.source_user_id
    and is_anonymous is true;

  if not found then
    raise exception 'Anonymous source account changed during merge'
      using errcode = '40001';
  end if;

  return jsonb_build_object(
    'tasks', moved_tasks,
    'sessions', moved_sessions,
    'behavior_events', moved_behavior_events,
    'reminder_events', moved_reminders,
    'reviews', moved_reviews
  );
end;
$$;

revoke all on function public.consume_account_merge(text)
  from public, anon;
grant execute on function public.consume_account_merge(text)
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

  select email, is_anonymous, email_confirmed_at
  into caller_email, caller_is_anonymous, caller_email_confirmed_at
  from auth.users
  where id = caller_id
  for update;

  if not found
    or caller_is_anonymous is true
    or caller_email is null
    or caller_email_confirmed_at is null
  then
    raise exception 'A verified permanent account is required'
      using errcode = '42501';
  end if;

  if not exists (
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
    delete from private.account_delete_tokens where user_id = caller_id;
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

  if not exists (
    select 1
    from auth.sessions
    where id = caller_session_id
      and user_id = caller_id
      and (not_after is null or not_after > clock_timestamp())
  ) then
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

create or replace function public.delete_my_account(p_token text)
returns void
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
  selected_token private.account_delete_tokens;
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

  select *
  into selected_token
  from private.account_delete_tokens
  where token_hash = extensions.digest(p_token, 'sha256')
  for update;

  if not found
    or selected_token.user_id <> caller_id
    or selected_token.expires_at <= clock_timestamp()
  then
    raise exception 'Account deletion verification is invalid or expired'
      using errcode = '42501';
  end if;

  select email, is_anonymous, email_confirmed_at
  into caller_email, caller_is_anonymous, caller_email_confirmed_at
  from auth.users
  where id = caller_id
  for update;

  if not found
    or caller_is_anonymous is true
    or caller_email is null
    or caller_email_confirmed_at is null
    or selected_token.email_hash
      <> extensions.digest(lower(btrim(caller_email)), 'sha256')
  then
    raise exception 'A verified permanent account is required'
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
  -- while a running or paused session exists. The remaining business rows and
  -- private metadata cascade from auth.users.
  delete from public.study_sessions where user_id = caller_id;
  delete from auth.users where id = caller_id;

  if not found then
    raise exception 'Account no longer exists' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.delete_my_account(text) from public, anon;
grant execute on function public.delete_my_account(text) to authenticated;

-- The existing pg_cron job keeps the same name and automatically calls this
-- replacement. Only anonymous identities inactive for 30 consecutive days are
-- selected; permanent accounts are never removed by retention maintenance.
create or replace function private.cleanup_expired_anonymous_users()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  expired_user_ids uuid[];
  deleted_count bigint;
begin
  delete from private.account_merge_tokens
  where expires_at <= clock_timestamp();

  delete from private.account_delete_tokens
  where expires_at <= clock_timestamp();

  insert into private.user_activity (user_id, last_active_at)
  select
    account.id,
    greatest(
      coalesce(account.last_sign_in_at, account.created_at),
      account.created_at
    )
  from auth.users as account
  where account.is_anonymous is true
  on conflict (user_id) do nothing;

  select coalesce(array_agg(candidate.id), '{}'::uuid[])
  into expired_user_ids
  from (
    select account.id
    from auth.users as account
    join private.user_activity as activity
      on activity.user_id = account.id
    where account.is_anonymous is true
      and activity.last_active_at
        < clock_timestamp() - interval '30 days'
    for update of account, activity skip locked
  ) as candidate;

  if cardinality(expired_user_ids) = 0 then
    return 0;
  end if;

  delete from public.study_sessions
  where user_id in (
    select account.id
    from auth.users as account
    join private.user_activity as activity
      on activity.user_id = account.id
    where account.id = any(expired_user_ids)
      and account.is_anonymous is true
      and activity.last_active_at
        < clock_timestamp() - interval '30 days'
  );

  delete from auth.users as account
  using private.user_activity as activity
  where account.id = any(expired_user_ids)
    and activity.user_id = account.id
    and account.is_anonymous is true
    and activity.last_active_at
      < clock_timestamp() - interval '30 days';

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function private.cleanup_expired_anonymous_users()
  from public, anon, authenticated;

comment on table private.user_activity is
  'Private last-activity ledger used only for anonymous identity retention.';
comment on table private.account_merge_tokens is
  'Short-lived hashed bearer secrets for moving an anonymous identity into an existing permanent account.';
comment on table private.account_delete_tokens is
  'Short-lived hashed deletion intents bound to the initiating account session.';
comment on function public.prepare_account_merge(text, text) is
  'Creates one short-lived, email-bound merge request for the current anonymous identity.';
comment on function public.refresh_account_merge(text) is
  'Refreshes the current merge request only when the caller still holds its bearer secret and source session.';
comment on function public.consume_account_merge(text) is
  'Moves an inactive anonymous identity into the verified permanent caller and deletes the anonymous auth user.';
comment on function public.prepare_account_deletion(text) is
  'Creates an email-OTP deletion intent bound to the current permanent account session.';
comment on function public.refresh_account_deletion(text) is
  'Refreshes an unconsumed deletion intent before resending its email OTP.';
comment on function public.delete_my_account(text) is
  'Consumes a deletion intent only from a newer email-OTP session, then deletes the caller and cascading StudyTrace data.';
comment on function private.cleanup_expired_anonymous_users() is
  'Deletes anonymous identities after 30 consecutive days without recorded activity.';

notify pgrst, 'reload schema';
