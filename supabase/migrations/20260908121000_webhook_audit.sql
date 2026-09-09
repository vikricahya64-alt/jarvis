-- Diagnostic: read-only webhook delivery audit, exposed as a REST RPC.
-- Call: POST /rest/v1/rpc/webhook_audit with {"limit_n":20}
-- Restricted to service_role only (fail-closed; no anon/authenticated).

create or replace function public.webhook_audit(limit_n integer default 20)
returns table (
  created timestamptz,
  status_code integer,
  error_msg text,
  hook_name text,
  request_url text,
  content text
)
language sql
security definer
set search_path = public, net, supabase_functions
as $$
  select r.created, r.status_code, r.error_msg, h.hook_name, q.url::text as request_url, r.content
  from net._http_response r
  left join supabase_functions.hooks h on h.request_id = r.id
  left join net.http_request_queue q on q.id = r.id
  order by r.created desc
  limit limit_n;
$$;

revoke all on function public.webhook_audit(integer) from public, anon, authenticated;
grant execute on function public.webhook_audit(integer) to service_role;