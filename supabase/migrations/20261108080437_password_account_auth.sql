-- Password accounts are independent of anonymous identities. Retire every
-- externally callable OTP/merge operation without rewriting migration history.
revoke all on function public.get_my_account_transfer_summary() from public, anon, authenticated;
revoke all on function public.prepare_account_merge(text, text) from public, anon, authenticated;
revoke all on function public.refresh_account_merge(text) from public, anon, authenticated;
revoke all on function public.consume_account_merge(text) from public, anon, authenticated;
revoke all on function public.cancel_account_merge(text) from public, anon, authenticated;
revoke all on function public.prepare_account_deletion(text) from public, anon, authenticated;
revoke all on function public.refresh_account_deletion(text) from public, anon, authenticated;
revoke all on function public.cancel_account_deletion(text) from public, anon, authenticated;
revoke all on function public.delete_my_account(text) from public, anon, authenticated;

create or replace function public.delete_my_password_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_session_id uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
  checked_at timestamptz := clock_timestamp();
  password_verified_at timestamptz;
  session_created_at timestamptz;
begin
  if caller_id is null or caller_session_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  -- AMR is a server-signed claim, never user_metadata. Token refresh does not
  -- update the password method timestamp and cannot renew this freshness gate.
  select max(to_timestamp((entry->>'timestamp')::double precision))
  into password_verified_at
  from jsonb_array_elements(
    case when jsonb_typeof(auth.jwt()->'amr') = 'array'
      then auth.jwt()->'amr' else '[]'::jsonb end
  ) as entry
  where entry->>'method' = 'password'
    and entry->>'timestamp' ~ '^[0-9]{1,12}([.][0-9]{1,6})?$';

  if password_verified_at is null
    or password_verified_at < checked_at - interval '5 minutes'
    or password_verified_at > checked_at + interval '5 seconds'
  then
    raise exception 'Fresh password authentication required' using errcode = '42501';
  end if;

  perform private.lock_owner_mutation_resources(array[caller_id]);
  perform private.lock_account_flow_resources(array[caller_id]);

  perform 1 from auth.users
  where id = caller_id and is_anonymous is false
    and nullif(email, '') is not null
    and nullif(encrypted_password, '') is not null
  for update;
  if not found then
    raise exception 'A password account is required' using errcode = '42501';
  end if;

  select created_at into session_created_at
  from auth.sessions
  where id = caller_session_id and user_id = caller_id
    and (not_after is null or not_after > checked_at)
  for update;
  if not found
    or session_created_at < checked_at - interval '5 minutes'
    or session_created_at > checked_at + interval '5 seconds'
  then
    raise exception 'Fresh password session required' using errcode = '42501';
  end if;

  -- Remove active sessions before tasks, respecting task lifecycle guards.
  -- All dependent business rows and Auth sessions cascade from these owners.
  delete from public.study_sessions where user_id = caller_id;
  delete from auth.users where id = caller_id;
end;
$$;

revoke all on function public.delete_my_password_account() from public, anon;
grant execute on function public.delete_my_password_account() to authenticated;
comment on function public.delete_my_password_account() is
  'Permanently deletes only the caller after fresh password AMR and a live Auth session; accepts no password or user ID.';
