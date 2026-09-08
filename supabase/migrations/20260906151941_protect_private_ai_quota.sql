-- Defense in depth for the server-side AI quota table. The authenticated
-- client reaches it only through the checked SECURITY DEFINER RPC.

alter table private.ai_generation_quota enable row level security;
