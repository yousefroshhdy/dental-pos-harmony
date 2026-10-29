-- Guard for the Supabase auth_rls_initplan advisor: no policy may call auth.uid()
-- (or auth.jwt()/auth.role()) per row. Wrap it as (select auth.uid()).
begin;
select plan(1);

select is(
  (select coalesce(string_agg(schemaname || '.' || tablename || '.' || policyname, ', '), '')
   from pg_policies
   where schemaname in ('core','authz','catalog','inventory','crm','field','work','sales','finance','perf','wf','audit','notify','integration')
     and regexp_replace(coalesce(qual, '') || ' ' || coalesce(with_check, ''),
                        '\(\s*SELECT\s+auth\.(uid|jwt|role)\(\)', '', 'gi') ~* 'auth\.(uid|jwt|role)\(\)'),
  '',
  'every policy evaluates auth.* once per statement'
);

select * from finish();
rollback;
