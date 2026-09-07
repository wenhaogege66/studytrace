-- The full shape validator is intentionally private and revoked. Keep it in
-- the SECURITY DEFINER trigger, while the table CHECK uses only built-ins so
-- authenticated inserts do not need EXECUTE on a private function.

alter table public.tasks
  drop constraint if exists tasks_steps_valid;

alter table public.tasks
  add constraint tasks_steps_count
  check (
    jsonb_typeof(steps) = 'array'
    and jsonb_array_length(steps) between 1 and 20
  ) not valid;

alter table public.tasks
  validate constraint tasks_steps_count;

notify pgrst, 'reload schema';
