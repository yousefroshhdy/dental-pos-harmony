-- Honest OS migration: every view runs with the caller's privileges and RLS.
--
-- Bug fixed: finance.v_customer_balances, finance.v_invoice_open_amounts and
-- inventory.v_stock were created as plain views. A plain view runs with its
-- OWNER's rights, which bypasses RLS on the base tables; combined with the
-- schema-wide `grant select` to authenticated, any signed-in user could read
-- every customer's balance (reproduced: a Cairo rep read a Delta customer's
-- balance). They were not reachable through PostgREST (only api/service are
-- exposed), but direct DB access paths must be as safe as the API.
--
-- Rule (tested by supabase/tests/database/15_view_security.test.sql): every
-- view in an application schema is security_invoker. SECURITY DEFINER commands
-- that read these views still see everything, because they run as the owner.

do $$
declare v record;
begin
  for v in
    select n.nspname, c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'v'
      and n.nspname in ('api','core','authz','catalog','inventory','crm','field','work','sales',
                        'finance','perf','wf','audit','notify','integration','service')
      and not coalesce(c.reloptions @> array['security_invoker=true'], false)
  loop
    execute format('alter view %I.%I set (security_invoker = true)', v.nspname, v.relname);
  end loop;
end $$;
