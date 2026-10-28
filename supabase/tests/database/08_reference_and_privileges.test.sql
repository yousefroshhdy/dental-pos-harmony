-- Reference data integrity and database privilege surface.
begin;
select plan(17);

select is((select count(*)::int from core.governorates), 27, 'all 27 governorates seeded');
select is((select count(*)::int from core.territories where level = 'region'), 5, 'five initial regions seeded');
select is((select count(*)::int from catalog.brands where code in ('BIONER','DERBY','RDT')), 3, 'three brands seeded');
select is((select count(*)::int from authz.role_permissions rp join authz.permissions p on p.code = rp.permission_code
           where not (rp.scope = any(p.allowed_scopes))), 0, 'every seeded grant uses an allowed scope');
select is((select count(*)::int from authz.role_permissions rp join authz.permissions p on p.code = rp.permission_code
           where rp.limit_value is not null and not p.supports_limit), 0, 'limits only on limit-capable permissions');
select is((select count(*)::int from authz.role_permissions rp join authz.roles r on r.id = rp.role_id where r.is_owner_role), 0,
  'owner role has no explicit grants (implicit all)');
select is((select count(*)::int from authz.role_permissions rp join authz.roles r on r.id = rp.role_id
           where r.code = 'admin' and split_part(rp.permission_code, '.', 1) in ('finance','sales','perf','inventory','wf')), 0,
  'IT admin holds no money, stock, commission or approval permissions');
select is((select count(*)::int from authz.role_permissions rp join authz.roles r on r.id = rp.role_id
           where r.code = 'sales_rep' and rp.permission_code in
             ('catalog.cost.read','perf.commission_plan.manage','inventory.adjustment.post','finance.page.aging','exec.page.overview')
              or (r.code = 'sales_rep' and rp.permission_code like 'wf.decide.%')), 0,
  'sales rep has none of the restricted permissions from the brief');
select is((select count(*)::int from unnest(array[
  'crm.customer.read','sales.order.read','sales.order.submit','sales.discount.apply','field.visit.create','field.visit.read',
  'field.location.read','catalog.product.read','catalog.price.read','catalog.cost.read','inventory.stock.read',
  'inventory.movement.read','inventory.adjustment.post','finance.invoice.read','finance.payment.read','finance.ledger.read',
  'perf.kpi.read','perf.commission.read','perf.commission_plan.read','admin.user.read','admin.role.read','admin.role.assign',
  'admin.role.manage','admin.user.create','admin.user.suspend','core.employee.read','core.employee.manage','work.task.read',
  'audit.log.read','audit.security.read']) c where not exists (select 1 from authz.permissions p where p.code = c)), 0,
  'every permission referenced by policies and commands exists');
select is((select rate_pct from perf.commission_plan_rules r join catalog.categories c on c.id = r.category_id where c.code = 'IMPLANT'),
  5.00::numeric(5,2), 'implant commission seeded at 5%');
select is((select rate_pct from perf.commission_plan_rules r join catalog.categories c on c.id = r.category_id where c.code = 'BUR'),
  1.50::numeric(5,2), 'bur commission seeded at 1.5%');
select is((select count(*)::int from wf.workflow_definitions d where not exists (
  select 1 from wf.workflow_rules r join wf.workflow_stages s on s.rule_id = r.id where r.definition_id = d.id)), 0,
  'every workflow has at least one approval stage');

-- Privilege surface
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'api' and has_function_privilege('anon', p.oid, 'execute')), 0,
  'anon can execute no api function');
select ok(has_function_privilege('authenticated', 'api.my_context()', 'execute'), 'authenticated can execute api commands');
select ok(not has_function_privilege('authenticated', 'core.bootstrap_owner(text, text)', 'execute'), 'app users cannot run owner bootstrap');
select ok(not has_function_privilege('authenticated', 'core.next_document_no(text, date)', 'execute'), 'app users cannot consume document numbers directly');
select ok(not exists (select 1 from information_schema.role_table_grants
                      where grantee = 'authenticated' and privilege_type in ('INSERT','UPDATE','DELETE')
                        and table_schema in ('authz','inventory','finance','sales','perf','audit','crm','field','catalog','wf')),
  'authenticated has no direct write grants on domain tables');

select * from finish();
rollback;
