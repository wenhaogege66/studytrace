-- StudyTrace v0.1
-- The browser sends only structured study records. Raw camera frames, audio,
-- landmarks, and biometric templates have no storage columns in this schema.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function private.set_updated_at() from public, anon, authenticated;

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  steps jsonb not null default '[]'::jsonb check (jsonb_typeof(steps) = 'array'),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  estimated_minutes integer not null check (estimated_minutes between 1 and 480),
  status text not null default 'planned' check (status in ('planned', 'in_progress', 'completed', 'archived')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.study_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'paused', 'completed', 'cancelled')),
  accumulated_seconds integer not null default 0 check (accumulated_seconds >= 0),
  started_at timestamptz not null default now(),
  resumed_at timestamptz,
  ended_at timestamptz,
  camera_enabled boolean not null default false,
  reminders_enabled boolean not null default true,
  experiment_mode boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint study_sessions_ended_after_started check (ended_at is null or ended_at >= started_at)
);

create table public.behavior_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.study_sessions(id) on delete cascade,
  event_type text not null check (event_type in ('face_absent', 'head_direction_change', 'manual')),
  direction text check (direction is null or direction in ('left', 'right', 'down', 'unknown')),
  source text not null check (source in ('vision', 'simulation', 'manual')),
  started_at timestamptz not null,
  ended_at timestamptz,
  review_status text not null default 'pending' check (review_status in ('pending', 'confirmed', 'corrected')),
  corrected_type text check (corrected_type is null or corrected_type in ('face_absent', 'head_direction_change', 'manual', 'not_relevant')),
  corrected_direction text check (corrected_direction is null or corrected_direction in ('left', 'right', 'down', 'unknown')),
  correction_note text check (correction_note is null or char_length(correction_note) <= 280),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint behavior_events_ended_after_started check (ended_at is null or ended_at >= started_at)
);

create table public.reminder_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.study_sessions(id) on delete cascade,
  behavior_event_id uuid references public.behavior_events(id) on delete cascade,
  shown_at timestamptz not null default now(),
  response text not null default 'none' check (response in ('none', 'dismissed', 'back_to_task')),
  responded_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null unique references public.study_sessions(id) on delete cascade,
  completion_status text not null check (completion_status in ('completed', 'partially_completed', 'not_completed')),
  self_rating smallint not null check (self_rating between 1 and 5),
  incomplete_reason text check (incomplete_reason is null or char_length(incomplete_reason) <= 500),
  next_adjustment text check (next_adjustment is null or char_length(next_adjustment) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  consent_version text not null default '2026-08-v1',
  consented_at timestamptz not null default now(),
  reminders_enabled boolean not null default true,
  camera_enabled_default boolean not null default false,
  privacy_mode text not null default 'local_only' check (privacy_mode = 'local_only'),
  experiment_mode boolean not null default false,
  calibration_seconds smallint not null default 3 check (calibration_seconds between 1 and 10),
  sample_fps smallint not null default 4 check (sample_fps between 1 and 10),
  face_absent_seconds smallint not null default 5 check (face_absent_seconds between 2 and 30),
  direction_hold_seconds smallint not null default 3 check (direction_hold_seconds between 1 and 15),
  neutral_recovery_seconds smallint not null default 1 check (neutral_recovery_seconds between 1 and 10),
  reminder_delay_seconds smallint not null default 15 check (reminder_delay_seconds between 3 and 120),
  reminder_cooldown_seconds integer not null default 600 check (reminder_cooldown_seconds between 30 and 3600),
  yaw_threshold_degrees smallint not null default 25 check (yaw_threshold_degrees between 10 and 60),
  pitch_threshold_degrees smallint not null default 20 check (pitch_threshold_degrees between 10 and 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index study_sessions_one_active_per_user_idx
  on public.study_sessions (user_id)
  where status in ('running', 'paused');

create index tasks_user_status_created_idx on public.tasks (user_id, status, created_at desc);
create index study_sessions_user_created_idx on public.study_sessions (user_id, created_at desc);
create index study_sessions_task_id_idx on public.study_sessions (task_id);
create index behavior_events_user_session_idx on public.behavior_events (user_id, session_id, started_at);
create index behavior_events_session_id_idx on public.behavior_events (session_id);
create index reminder_events_user_session_idx on public.reminder_events (user_id, session_id, shown_at);
create index reminder_events_session_id_idx on public.reminder_events (session_id);
create index reminder_events_behavior_event_id_idx on public.reminder_events (behavior_event_id) where behavior_event_id is not null;
create index reviews_user_created_idx on public.reviews (user_id, created_at desc);

create trigger tasks_set_updated_at before update on public.tasks
for each row execute function private.set_updated_at();
create trigger study_sessions_set_updated_at before update on public.study_sessions
for each row execute function private.set_updated_at();
create trigger behavior_events_set_updated_at before update on public.behavior_events
for each row execute function private.set_updated_at();
create trigger reviews_set_updated_at before update on public.reviews
for each row execute function private.set_updated_at();
create trigger user_settings_set_updated_at before update on public.user_settings
for each row execute function private.set_updated_at();

alter table public.tasks enable row level security;
alter table public.study_sessions enable row level security;
alter table public.behavior_events enable row level security;
alter table public.reminder_events enable row level security;
alter table public.reviews enable row level security;
alter table public.user_settings enable row level security;

create policy tasks_select_own on public.tasks for select to authenticated
using ((select auth.uid()) = user_id);
create policy tasks_insert_own on public.tasks for insert to authenticated
with check ((select auth.uid()) = user_id);
create policy tasks_update_own on public.tasks for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy tasks_delete_own on public.tasks for delete to authenticated
using ((select auth.uid()) = user_id);

create policy study_sessions_select_own on public.study_sessions for select to authenticated
using ((select auth.uid()) = user_id);
create policy study_sessions_insert_own on public.study_sessions for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.tasks
    where tasks.id = task_id and tasks.user_id = (select auth.uid())
  )
);
create policy study_sessions_update_own on public.study_sessions for update to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.tasks
    where tasks.id = task_id and tasks.user_id = (select auth.uid())
  )
);
create policy study_sessions_delete_own on public.study_sessions for delete to authenticated
using ((select auth.uid()) = user_id);

create policy behavior_events_select_own on public.behavior_events for select to authenticated
using ((select auth.uid()) = user_id);
create policy behavior_events_insert_own on public.behavior_events for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.study_sessions
    where study_sessions.id = session_id and study_sessions.user_id = (select auth.uid())
  )
);
create policy behavior_events_update_own on public.behavior_events for update to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.study_sessions
    where study_sessions.id = session_id and study_sessions.user_id = (select auth.uid())
  )
);
create policy behavior_events_delete_own on public.behavior_events for delete to authenticated
using ((select auth.uid()) = user_id);

create policy reminder_events_select_own on public.reminder_events for select to authenticated
using ((select auth.uid()) = user_id);
create policy reminder_events_insert_own on public.reminder_events for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.study_sessions
    where study_sessions.id = session_id and study_sessions.user_id = (select auth.uid())
  )
  and (
    behavior_event_id is null
    or exists (
      select 1 from public.behavior_events
      where behavior_events.id = behavior_event_id
        and behavior_events.session_id = reminder_events.session_id
        and behavior_events.user_id = (select auth.uid())
    )
  )
);
create policy reminder_events_update_own on public.reminder_events for update to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.study_sessions
    where study_sessions.id = session_id and study_sessions.user_id = (select auth.uid())
  )
  and (
    behavior_event_id is null
    or exists (
      select 1 from public.behavior_events
      where behavior_events.id = behavior_event_id
        and behavior_events.session_id = reminder_events.session_id
        and behavior_events.user_id = (select auth.uid())
    )
  )
);
create policy reminder_events_delete_own on public.reminder_events for delete to authenticated
using ((select auth.uid()) = user_id);

create policy reviews_select_own on public.reviews for select to authenticated
using ((select auth.uid()) = user_id);
create policy reviews_insert_own on public.reviews for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.study_sessions
    where study_sessions.id = session_id and study_sessions.user_id = (select auth.uid())
  )
);
create policy reviews_update_own on public.reviews for update to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.study_sessions
    where study_sessions.id = session_id and study_sessions.user_id = (select auth.uid())
  )
);
create policy reviews_delete_own on public.reviews for delete to authenticated
using ((select auth.uid()) = user_id);

create policy user_settings_select_own on public.user_settings for select to authenticated
using ((select auth.uid()) = user_id);
create policy user_settings_insert_own on public.user_settings for insert to authenticated
with check ((select auth.uid()) = user_id);
create policy user_settings_update_own on public.user_settings for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy user_settings_delete_own on public.user_settings for delete to authenticated
using ((select auth.uid()) = user_id);

revoke all on table public.tasks, public.study_sessions, public.behavior_events,
  public.reminder_events, public.reviews, public.user_settings from public, anon;
grant select, insert, update, delete on table public.tasks, public.study_sessions,
  public.behavior_events, public.reminder_events, public.reviews, public.user_settings to authenticated;

create or replace function public.delete_my_data()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
begin
  if caller_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  delete from public.reminder_events where user_id = caller_id;
  delete from public.behavior_events where user_id = caller_id;
  delete from public.reviews where user_id = caller_id;
  delete from public.study_sessions where user_id = caller_id;
  delete from public.tasks where user_id = caller_id;
  delete from public.user_settings where user_id = caller_id;
end;
$$;

revoke all on function public.delete_my_data() from public, anon;
grant execute on function public.delete_my_data() to authenticated;

create extension if not exists pg_cron with schema pg_catalog;

create or replace function private.cleanup_expired_anonymous_users()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count bigint;
begin
  delete from auth.users
  where is_anonymous is true
    and created_at < now() - interval '30 days';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function private.cleanup_expired_anonymous_users() from public, anon, authenticated;

select cron.schedule(
  'studytrace-cleanup-expired-anonymous-users',
  '17 3 * * *',
  $$select private.cleanup_expired_anonymous_users();$$
)
where not exists (
  select 1 from cron.job where jobname = 'studytrace-cleanup-expired-anonymous-users'
);
