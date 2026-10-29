-- Regression tests for the 2026-10-29 independent audit. Each block replays the
-- auditor's reproduction and asserts the fixed behaviour. (#6 → suite 11, #10 → 14, #11 → 02.)
begin;
select tests.load_fixture();
select plan(23);
set constraints all immediate;

-- Shared stock: quarantine warehouse with a recalled lot, main warehouse with good stock
insert into inventory.warehouses (id, code, name, kind) values ('60000000-0000-0000-0000-0000000000f1','WH-QUAR','Quarantine','quarantine');
insert into inventory.lots (id, variant_id, lot_no, expiry_date) values
  ('61000000-0000-0000-0000-0000000000f1','53000000-0000-0000-0000-000000000001','L-RECALLED','2029-01-01'),
  ('61000000-0000-0000-0000-0000000000f2','53000000-0000-0000-0000-000000000001','L-GOOD','2030-06-30');
insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity, source_doc_type) values
  ('receipt','60000000-0000-0000-0000-0000000000f1','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-0000000000f1', 3, 'receipt'),
  ('receipt','60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-0000000000f2', 30, 'receipt');

-- ---- #1 quarantine stock is never sellable ----
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select api.save_order_draft('70000000-0000-0000-0000-0000000000a1','40000000-0000-0000-0000-000000000001','[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":2}]');
select api.submit_order('70000000-0000-0000-0000-0000000000a1');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select api.approve_order('70000000-0000-0000-0000-0000000000a1');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_like($$select api.reserve_order('70000000-0000-0000-0000-0000000000a1','60000000-0000-0000-0000-0000000000f1')$$,
  'WAREHOUSE_NOT_SELLABLE%', '#1 an order cannot be reserved from a quarantine warehouse');
select is(api.reserve_order('70000000-0000-0000-0000-0000000000a1','60000000-0000-0000-0000-000000000001') ->> 'status',
  'reserved', '#1 the same order reserves normally from a sellable warehouse');
select tests.clear_authentication();
select throws_like($$insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity)
  values ('sale_issue','60000000-0000-0000-0000-0000000000f1','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-0000000000f1', -1)$$,
  'WAREHOUSE_NOT_SELLABLE%', '#1 no sale_issue movement from quarantine, whatever the code path');
select lives_ok($$insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity, reason_code)
  values ('damage','60000000-0000-0000-0000-0000000000f1','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-0000000000f1', -1, 'recall destroy')$$,
  '#1 quarantine stock can still be written off');

-- ---- #2 blocked / archived customers ----
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select api.save_order_draft('70000000-0000-0000-0000-0000000000a2','40000000-0000-0000-0000-000000000001','[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}]');
select api.save_order_draft('70000000-0000-0000-0000-0000000000a3','40000000-0000-0000-0000-000000000001','[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}]');
select api.submit_order('70000000-0000-0000-0000-0000000000a3');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select api.approve_order('70000000-0000-0000-0000-0000000000a3');
select tests.clear_authentication();
update crm.customers set lifecycle_stage = 'blocked' where id = '40000000-0000-0000-0000-000000000001';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.submit_order('70000000-0000-0000-0000-0000000000a2')$$, 'CUSTOMER_BLOCKED%',
  '#2 a draft for a blocked customer cannot be submitted');
select is(api.cancel_order('70000000-0000-0000-0000-0000000000a2', 'customer on credit hold') ->> 'status', 'cancelled',
  '#2 the draft can still be cancelled');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_like($$select api.reserve_order('70000000-0000-0000-0000-0000000000a3','60000000-0000-0000-0000-000000000001')$$,
  'CUSTOMER_BLOCKED%', '#2 an approved order of a blocked customer cannot be reserved');
select tests.clear_authentication();
update crm.customers set lifecycle_stage = 'active' where id = '40000000-0000-0000-0000-000000000001';

-- ---- #3 adjustment limit is cumulative per user/warehouse/variant/day (limit 5) ----
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(api.request_inventory_adjustment('60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-0000000000f2', -2, 'count', 'split-1') ->> 'status', 'posted', '#3 first small adjustment posts');
select is(api.request_inventory_adjustment('60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-0000000000f2', -2, 'count', 'split-2') ->> 'status', 'posted', '#3 second posts (4 of 5 used)');
select is(api.request_inventory_adjustment('60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-0000000000f2', -2, 'count', 'split-3') ->> 'status', 'pending_approval', '#3 the split that exceeds the daily limit needs approval');

-- ---- #4 audit row images are not readable by clients ----
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select throws_like($$select new_data from audit.audit_log limit 1$$, '%permission denied%', '#4 admin cannot read old/new row images');
select ok((select count(*) from api.v_audit_log) > 0, '#4 admin still reads audit metadata through the view');

-- ---- #5 #8 internal definer helpers are not client-callable ----
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select * from sales.resolve_list_price('40000000-0000-0000-0000-000000000002','53000000-0000-0000-0000-000000000001',1)$$,
  '%permission denied%', '#5 reps cannot probe other customers'' price lists');
select throws_like($$select authz.log_security_event('role_granted','critical','{"forged":true}')$$,
  '%permission denied%', '#8 nobody can forge security events');
select tests.clear_authentication();
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute')
             and n.nspname in ('core','authz','catalog','inventory','crm','field','work','sales','finance','perf','wf','audit','notify','integration')
             and not exists (select 1 from pg_policies pol where coalesce(pol.qual,'') || ' ' || coalesce(pol.with_check,'') ~ ('\m' || p.proname || '\M'))
             and not exists (select 1 from pg_views v where v.definition ~ ('\m' || p.proname || '\M'))),
          0, '#5 #8 every client-executable internal definer function is needed by a policy or view');

-- ---- #7 owner reactivation is owner-only ----
insert into authz.user_roles (user_id, role_id) select '00000000-0000-0000-0000-0000000000a2', id from authz.roles where is_owner_role;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select api.suspend_user('00000000-0000-0000-0000-0000000000a2', 'co-owner under investigation');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select throws_like($$select api.reactivate_user('00000000-0000-0000-0000-0000000000a2', 'undo')$$, 'OWNER_ONLY%',
  '#7 an IT admin cannot reactivate a suspended owner');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select throws_like($$select api.reactivate_user('00000000-0000-0000-0000-0000000000a1', 'me')$$, 'SELF_REACTIVATE_FORBIDDEN%',
  '#7 nobody reactivates themselves');
select lives_ok($$select api.reactivate_user('00000000-0000-0000-0000-0000000000a2', 'cleared')$$, '#7 an owner can reactivate a co-owner');
select tests.clear_authentication();
-- End the temporary co-ownership so later blocks see a2 as a plain sales director.
update authz.user_roles set revoked_at = now()
where user_id = '00000000-0000-0000-0000-0000000000a2' and role_id = (select id from authz.roles where is_owner_role);

-- ---- #12 a visit id belonging to someone else cannot be (re)used ----
select tests.clear_authentication();
insert into field.visits (id, customer_id, employee_id, planned_for)
values ('80000000-0000-0000-0000-0000000000a5','40000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000005', current_date);
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.visit_check_in('80000000-0000-0000-0000-0000000000a5','40000000-0000-0000-0000-000000000001',30.0444,31.2357,10,now())$$,
  'PERMISSION_DENIED%', '#12 a rep cannot check in on another rep''s visit id');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is(api.visit_check_in('80000000-0000-0000-0000-0000000000a5','40000000-0000-0000-0000-000000000002',31.0409,31.3785,10,now()) ->> 'replayed',
  'false', '#12 the owner''s own check-in is not hijacked into a replay');

-- ---- #13 team-scoped admin read sees the team only ----
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from core.user_profiles), 4, '#13 sales director (admin.user.read team) sees self + team profiles only');

-- ---- #14 removing a permission needs the same authority as granting it ----
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select throws_like($$select api.remove_role_permission((select id from authz.roles where code = 'sales_director'), 'sales.order.approve')$$,
  'ESCALATION_BLOCKED%', '#14 an IT admin cannot strip sales permissions it does not hold');

-- ---- #15 a retried grant cannot duplicate an assignment ----
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$select api.grant_role('00000000-0000-0000-0000-0000000000a5', (select id from authz.roles where code = 'sales_rep'))$$,
  '23505', null, '#15 granting the same active role twice is refused');

select * from finish();
rollback;
