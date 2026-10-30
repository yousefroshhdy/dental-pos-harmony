-- Guard: every wf.on_decided_* hook function that exists is wired into the single
-- consolidated dispatch, so a module built in parallel can never lose its branch.
begin;
select plan(1);
select is(
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'wf' and p.proname like 'on\_decided\_%'
     and position('wf.' || p.proname || '(' in pg_get_functiondef('wf.dispatch_decision_hook(text,uuid,boolean)'::regprocedure)) = 0),
  '',
  'every wf.on_decided_* hook is called by wf.dispatch_decision_hook'
);
select * from finish();
rollback;
