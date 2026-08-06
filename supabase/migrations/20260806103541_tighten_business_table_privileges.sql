-- Supabase's default table privileges can include operations beyond the Data API
-- surface. Keep the browser role limited to the four operations used by the app.

revoke all on table public.tasks, public.study_sessions, public.behavior_events,
  public.reminder_events, public.reviews, public.user_settings
  from public, anon, authenticated;

grant select, insert, update, delete on table public.tasks, public.study_sessions,
  public.behavior_events, public.reminder_events, public.reviews, public.user_settings
  to authenticated;

-- Require every future public table to opt into browser access explicitly.
alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated;
