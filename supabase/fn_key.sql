-- Edge functions are verify_jwt=false but only answer calls carrying x-fn-key.
-- The key lives in Vault ('fn_key'); pg_net callers send it via fn_headers(),
-- functions read it with the service role via fn_key(). Anon cannot execute either.
select vault.create_secret(encode(extensions.gen_random_bytes(24),'hex'), 'fn_key');
create or replace function public.fn_key() returns text language sql security definer set search_path = '' stable as
$$ select decrypted_secret from vault.decrypted_secrets where name = 'fn_key' $$;
revoke all on function public.fn_key() from public, anon, authenticated;
grant execute on function public.fn_key() to service_role;
create or replace function public.fn_headers() returns jsonb language sql security definer set search_path = '' stable as
$$ select jsonb_build_object('Content-Type','application/json','x-fn-key', public.fn_key()) $$;
revoke all on function public.fn_headers() from public, anon, authenticated;
-- *_start() functions: net.http_post(..., headers := public.fn_headers(), ...)
