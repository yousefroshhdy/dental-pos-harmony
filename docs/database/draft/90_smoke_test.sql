-- =============================================================================
-- SMOKE TEST for the draft schema (local PostgreSQL 16 + 00_supabase_stub.sql).
-- Proves the core invariants hold BEFORE Phase 2 turns the draft into migrations.
-- Run:  psql -v ON_ERROR_STOP=1 -f 00_supabase_stub.sql -f 10_schema_draft.sql -f 90_smoke_test.sql
-- Every check prints PASS or aborts with FAIL.
-- =============================================================================
\set QUIET on
set client_min_messages = notice;

create schema test;
grant usage on schema test to authenticated;

create function test.as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), false);
  execute 'set role authenticated';
end $$;
create function test.as_admin() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', false);
end $$;
create function test.ok(p_cond boolean, p_label text) returns void language plpgsql as $$
begin
  if p_cond then raise notice 'PASS  %', p_label;
  else raise exception 'FAIL  %', p_label; end if;
end $$;
create function test.expect_error(p_sql text, p_like text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute 'set constraints all immediate';
    execute p_sql;
  exception when others then
    if sqlerrm like p_like then raise notice 'PASS  % (got: %)', p_label, sqlerrm; return;
    else raise exception 'FAIL  % — expected "%", got "%"', p_label, p_like, sqlerrm; end if;
  end;
  raise exception 'FAIL  % — statement succeeded but should have failed', p_label;
end $$;
grant execute on all functions in schema test to authenticated;

-- ---------------------------------------------------------------------------
-- Seed (as admin; superuser bypasses RLS)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@honest.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'am.cairo@honest.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'rep.cairo@honest.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'rep.delta@honest.test'),
  ('00000000-0000-0000-0000-0000000000a5', 'finance@honest.test');

insert into core.governorates values ('CAI','Cairo','القاهرة'), ('GIZ','Giza','الجيزة'), ('DK','Dakahlia','الدقهلية');
insert into core.territories (id, code, name_en, name_ar, level) values
  ('10000000-0000-0000-0000-000000000001', 'CAI-GIZ', 'Cairo & Giza', 'القاهرة والجيزة', 'region'),
  ('10000000-0000-0000-0000-000000000002', 'DELTA',   'Delta',        'الدلتا',          'region');
insert into core.territories (id, code, name_en, name_ar, level, parent_id) values
  ('10000000-0000-0000-0000-000000000003', 'CAI-NASR', 'Nasr City', 'مدينة نصر', 'area', '10000000-0000-0000-0000-000000000001');

insert into core.employees (id, employee_no, user_id, full_name_en, job_title, manager_id) values
  ('20000000-0000-0000-0000-000000000001', 'E001', '00000000-0000-0000-0000-0000000000a1', 'Owner',       'Company Owner', null),
  ('20000000-0000-0000-0000-000000000002', 'E002', '00000000-0000-0000-0000-0000000000a2', 'Area Mgr',    'Area Manager',  '20000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000003', 'E003', '00000000-0000-0000-0000-0000000000a3', 'Rep Cairo',   'Sales Representative', '20000000-0000-0000-0000-000000000002'),
  ('20000000-0000-0000-0000-000000000004', 'E004', '00000000-0000-0000-0000-0000000000a4', 'Rep Delta',   'Sales Representative', '20000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000005', 'E005', '00000000-0000-0000-0000-0000000000a5', 'Finance',     'Finance Officer', '20000000-0000-0000-0000-000000000001');
insert into core.user_profiles (user_id, employee_id)
  select user_id, id from core.employees;
insert into core.employee_territories (employee_id, territory_id, assignment) values
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'manager'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', 'member'),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000002', 'member');

insert into authz.permissions (code, module, description, supports_limit) values
  ('crm.customer.read','crm','Read customers',false),
  ('sales.order.read','sales','Read orders',false),
  ('sales.order.submit','sales','Submit orders',false),
  ('sales.discount.apply','sales','Apply manual discount (limit = max %)',true),
  ('field.visit.create','field','Check in / create visits',false),
  ('field.visit.read','field','Read visits',false),
  ('catalog.product.read','catalog','Read products',false),
  ('catalog.price.read','catalog','Read selling prices',false),
  ('catalog.cost.read','catalog','Read purchase costs',false),
  ('inventory.stock.read','inventory','Read stock',false),
  ('inventory.adjustment.post','inventory','Post adjustments (limit = units)',true),
  ('finance.invoice.read','finance','Read invoices',false),
  ('admin.role.assign','admin','Assign roles',false),
  ('admin.role.read','admin','Read roles',false);

insert into authz.roles (id, code, name_en, is_system, is_owner_role) values
  ('30000000-0000-0000-0000-000000000001', 'owner',        'Owner',               true, true),
  ('30000000-0000-0000-0000-000000000002', 'area_manager', 'Area Manager',        true, false),
  ('30000000-0000-0000-0000-000000000003', 'sales_rep',    'Sales Representative',true, false),
  ('30000000-0000-0000-0000-000000000004', 'finance',      'Finance Officer',     true, false);
insert into authz.role_permissions (role_id, permission_code, scope, limit_value) values
  -- rep: own customers/orders, 3% manual discount, products & prices, no cost
  ('30000000-0000-0000-0000-000000000003','crm.customer.read','own',null),
  ('30000000-0000-0000-0000-000000000003','sales.order.read','own',null),
  ('30000000-0000-0000-0000-000000000003','sales.order.submit','own',null),
  ('30000000-0000-0000-0000-000000000003','sales.discount.apply','own',3),
  ('30000000-0000-0000-0000-000000000003','field.visit.create','own',null),
  ('30000000-0000-0000-0000-000000000003','field.visit.read','own',null),
  ('30000000-0000-0000-0000-000000000003','catalog.product.read','all',null),
  ('30000000-0000-0000-0000-000000000003','catalog.price.read','all',null),
  -- area manager: territory customers, team orders, 10% discount, may assign roles
  ('30000000-0000-0000-0000-000000000002','crm.customer.read','territory',null),
  ('30000000-0000-0000-0000-000000000002','sales.order.read','team',null),
  ('30000000-0000-0000-0000-000000000002','sales.order.submit','team',null),
  ('30000000-0000-0000-0000-000000000002','sales.discount.apply','team',10),
  ('30000000-0000-0000-0000-000000000002','field.visit.create','own',null),
  ('30000000-0000-0000-0000-000000000002','field.visit.read','team',null),
  ('30000000-0000-0000-0000-000000000002','catalog.product.read','all',null),
  ('30000000-0000-0000-0000-000000000002','catalog.price.read','all',null),
  ('30000000-0000-0000-0000-000000000002','admin.role.assign','team',null),
  -- finance
  ('30000000-0000-0000-0000-000000000004','finance.invoice.read','all',null),
  ('30000000-0000-0000-0000-000000000004','crm.customer.read','all',null);
insert into authz.user_roles (user_id, role_id) values
  ('00000000-0000-0000-0000-0000000000a1','30000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-0000000000a2','30000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-0000000000a3','30000000-0000-0000-0000-000000000003'),
  ('00000000-0000-0000-0000-0000000000a4','30000000-0000-0000-0000-000000000003'),
  ('00000000-0000-0000-0000-0000000000a5','30000000-0000-0000-0000-000000000004');

insert into crm.customers (id, customer_no, doctor_name, display_name, territory_id, lifecycle_stage, phone_primary, latitude, longitude) values
  ('40000000-0000-0000-0000-000000000001','C-0001','Dr. Ahmed','Dr. Ahmed Clinic','10000000-0000-0000-0000-000000000003','active','+201001234567', 30.044400, 31.235700),
  ('40000000-0000-0000-0000-000000000002','C-0002','Dr. Mona','Dr. Mona Clinic', '10000000-0000-0000-0000-000000000002','active','+201112345678', 31.040900, 31.378500);
insert into crm.customer_assignments (customer_id, employee_id) values
  ('40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000003'),
  ('40000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000004');

insert into catalog.brands (id, code, name, country_of_origin) values ('50000000-0000-0000-0000-000000000001','BIONER','Bioner','Spain');
insert into catalog.categories (id, code, name_en, name_ar) values ('51000000-0000-0000-0000-000000000001','IMPLANT','Dental implants','زرعات');
insert into catalog.products (id, brand_id, category_id, code, name_en) values
  ('52000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','51000000-0000-0000-0000-000000000001','BIO-TOP','Bioner Top DM');
insert into catalog.product_variants (id, product_id, sku, name_en) values
  ('53000000-0000-0000-0000-000000000001','52000000-0000-0000-0000-000000000001','BIO-TOP-4110','Top DM 4.1x10');
insert into catalog.product_costs (variant_id, unit_cost, effective_from) values ('53000000-0000-0000-0000-000000000001', 600, '2026-01-01');
insert into catalog.price_lists (id, code, name, kind, valid_from) values ('54000000-0000-0000-0000-000000000001','DEFAULT','Default 2026','standard','2026-01-01');
insert into catalog.price_list_items values ('54000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001', 1000, 1);

insert into inventory.warehouses (id, code, name) values ('60000000-0000-0000-0000-000000000001','WH-CAI','Cairo main');
insert into inventory.lots (id, variant_id, lot_no, expiry_date) values ('61000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','L2026A','2030-12-31');

insert into wf.workflow_definitions (code, name, entity_type) values ('sales.order.discount','Order discount approval','sales.order');
insert into core.system_settings (key, value) values ('field.geofence_radius_m', '150'), ('field.max_accuracy_m', '100');

-- ---------------------------------------------------------------------------
-- 1. RLS: territory / ownership visibility
-- ---------------------------------------------------------------------------
select test.as_user('00000000-0000-0000-0000-0000000000a3');  -- Cairo rep
select test.ok((select count(*) from crm.customers) = 1
           and (select customer_no from crm.customers) = 'C-0001', 'rep sees only own assigned customer');
select test.ok((select count(*) from catalog.product_costs) = 0, 'rep cannot see purchase costs (field-level by table split)');
select test.ok((select count(*) from catalog.price_list_items) = 1, 'rep can see approved selling prices');

select test.as_user('00000000-0000-0000-0000-0000000000a2');  -- Cairo area manager
select test.ok((select count(*) from crm.customers) = 1
           and (select customer_no from crm.customers) = 'C-0001', 'area manager sees territory (incl. sub-areas), not Delta');

select test.as_user('00000000-0000-0000-0000-0000000000a5');  -- finance
select test.ok((select count(*) from crm.customers) = 2, 'finance (scope=all) sees all customers');

select test.as_user(null);                                     -- no session
select test.ok((select count(*) from crm.customers) = 0, 'anonymous/unknown user sees nothing (deny by default)');

-- ---------------------------------------------------------------------------
-- 2. Inventory ledger
-- ---------------------------------------------------------------------------
select test.as_admin();
insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity, source_doc_type)
values ('receipt','60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001', 10, 'receipt');
select test.ok((select on_hand from inventory.stock_balances) = 10, 'receipt movement updates derived balance');
select test.expect_error($$insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity)
  values ('adjustment_out','60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001', -15)$$,
  'INSUFFICIENT_STOCK%', 'negative stock is rejected');
select test.expect_error($$update inventory.movements set quantity = 999$$, 'APPEND_ONLY%', 'ledger rows cannot be edited');
select test.expect_error($$delete from inventory.movements$$, 'APPEND_ONLY%', 'ledger rows cannot be deleted');
select test.expect_error($$insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity)
  values ('receipt','60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001', -1)$$,
  '%violates check constraint%', 'movement sign must match its type');

select test.as_user('00000000-0000-0000-0000-0000000000a3');
select test.expect_error($$update inventory.stock_balances set on_hand = 1000$$, '%permission denied%', 'rep cannot write balances directly');
select test.expect_error($$select api.post_inventory_adjustment('60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001', 5, 'found', 'k1')$$,
  'PERMISSION_DENIED%', 'rep cannot post inventory adjustments');

-- ---------------------------------------------------------------------------
-- 3. Orders: server-side pricing, discount authority, ABAC
-- ---------------------------------------------------------------------------
select test.as_admin();
insert into sales.orders (id, customer_id, employee_id) values
  ('70000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000003'),
  ('70000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000003'),
  ('70000000-0000-0000-0000-000000000003','40000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000004');
-- Tampered client payload: list_price 1 EGP. The server must overwrite it.
insert into sales.order_items (order_id, line_no, variant_id, quantity, list_price, requested_discount_pct, tax_rate_pct, line_subtotal, line_discount, line_tax, line_total) values
  ('70000000-0000-0000-0000-000000000001', 1, '53000000-0000-0000-0000-000000000001', 2, 1, 2, 0, 0,0,0,0),
  ('70000000-0000-0000-0000-000000000002', 1, '53000000-0000-0000-0000-000000000001', 1, 1, 5, 0, 0,0,0,0),
  ('70000000-0000-0000-0000-000000000003', 1, '53000000-0000-0000-0000-000000000001', 1, 1, 0, 0, 0,0,0,0);

select test.as_user('00000000-0000-0000-0000-0000000000a3');
select test.ok((select api.submit_order('70000000-0000-0000-0000-000000000001') ->> 'status') = 'submitted', 'order within 3% limit is submitted');
select test.ok((select total from sales.orders where id = '70000000-0000-0000-0000-000000000001') = 2234.40,
  'server recomputes price: 2×1000, −2% (40), +14% VAT on 1960 (274.40) = 2234.40 — tampered price ignored');
select test.ok((select order_no from sales.orders where id = '70000000-0000-0000-0000-000000000001') like 'SO-%-000001', 'gapless document number assigned');
select test.ok((select api.submit_order('70000000-0000-0000-0000-000000000002') ->> 'status') = 'pending_approval', 'order above 3% limit routes to approval');
select test.as_admin();
select test.ok((select count(*) from wf.approval_requests where entity_id = '70000000-0000-0000-0000-000000000002' and status = 'pending') = 1, 'approval request created');
select test.ok((select count(*) from integration.outbox where aggregate_id in ('70000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000002')) = 2, 'outbox events written in the same transaction');
select test.as_user('00000000-0000-0000-0000-0000000000a3');
select test.expect_error($$select api.submit_order('70000000-0000-0000-0000-000000000003')$$, 'PERMISSION_DENIED%', 'rep cannot submit another rep''s order');
select test.expect_error($$select api.submit_order('70000000-0000-0000-0000-000000000001')$$, 'INVALID_STATE%', 'an order cannot be submitted twice');
select test.expect_error($$update sales.orders set total = 1 where id = '70000000-0000-0000-0000-000000000001'$$, '%permission denied%', 'rep cannot edit order totals directly');
select test.ok((select count(*) from sales.orders) = 2, 'rep sees only own orders');

-- ---------------------------------------------------------------------------
-- 4. GPS check-in verification
-- ---------------------------------------------------------------------------
select test.ok((select api.visit_check_in('80000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',
  30.044800, 31.235700, 20, now(), '{}') ->> 'verification_status') = 'verified', 'check-in ~45 m from clinic is verified');
select test.ok((select api.visit_check_in('80000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',
  30.044800, 31.235700, 20, now(), '{}') ->> 'replayed') = 'true', 'offline replay of same visit id is idempotent');
select test.ok((select api.visit_check_in('80000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000001',
  30.064400, 31.235700, 20, now() + interval '1 minute', '{}') ->> 'verification_status') = 'out_of_range', 'check-in ~2.2 km away is out_of_range');
select test.ok((select api.visit_check_in('80000000-0000-0000-0000-000000000003','40000000-0000-0000-0000-000000000001',
  30.044500, 31.235700, 350, now() + interval '2 minutes', '{}') ->> 'verification_status') = 'low_accuracy', 'poor GPS accuracy is not silently verified');
select test.ok((select api.visit_check_in('80000000-0000-0000-0000-000000000004','40000000-0000-0000-0000-000000000001',
  31.200000, 29.918700, 10, now() + interval '3 minutes', '{}') -> 'anomaly_flags') ? 'impossible_travel', 'Cairo→Alexandria in 1 minute flagged impossible_travel');
select test.expect_error($$select api.visit_check_in('80000000-0000-0000-0000-000000000009','40000000-0000-0000-0000-000000000002', 31.0409, 31.3785, 10, now(), '{}')$$,
  'PERMISSION_DENIED%', 'rep cannot check in at a customer outside their scope');

-- ---------------------------------------------------------------------------
-- 5. Owner lock-out safeguard & privilege escalation
-- ---------------------------------------------------------------------------
select test.as_admin();
select test.expect_error($$update authz.user_roles set revoked_at = now() where role_id = '30000000-0000-0000-0000-000000000001'$$,
  'LAST_OWNER%', 'cannot revoke the last owner');
select test.expect_error($$update core.user_profiles set status = 'suspended' where user_id = '00000000-0000-0000-0000-0000000000a1'$$,
  'LAST_OWNER%', 'cannot suspend the last owner');
select test.expect_error($$delete from authz.roles where is_owner_role$$, 'OWNER_ROLE_PROTECTED%', 'owner role cannot be deleted');
select test.expect_error($$update authz.roles set is_active = false where is_owner_role$$, 'OWNER_ROLE_PROTECTED%', 'owner role cannot be deactivated');

select test.as_user('00000000-0000-0000-0000-0000000000a2');   -- area manager holds admin.role.assign
select test.expect_error($$select api.grant_role('00000000-0000-0000-0000-0000000000a3','30000000-0000-0000-0000-000000000004')$$,
  'ESCALATION_BLOCKED%', 'manager cannot grant a role with permissions they do not hold (finance)');
select test.expect_error($$select api.grant_role('00000000-0000-0000-0000-0000000000a3','30000000-0000-0000-0000-000000000001')$$,
  'OWNER_ONLY%', 'non-owner cannot grant the owner role');
select test.expect_error($$select api.grant_role('00000000-0000-0000-0000-0000000000a2','30000000-0000-0000-0000-000000000003')$$,
  'SELF_GRANT_FORBIDDEN%', 'users cannot grant roles to themselves');
select test.ok((select api.grant_role('00000000-0000-0000-0000-0000000000a3','30000000-0000-0000-0000-000000000003', null, 'test')) is not null,
  'manager can grant a role whose permissions they hold');

select test.as_user('00000000-0000-0000-0000-0000000000a3');
select test.expect_error($$insert into authz.user_roles (user_id, role_id) values ('00000000-0000-0000-0000-0000000000a3','30000000-0000-0000-0000-000000000001')$$,
  '%permission denied%', 'rep cannot insert role grants directly');

-- ---------------------------------------------------------------------------
-- 6. Finance immutability & audit trail
-- ---------------------------------------------------------------------------
select test.as_admin();
insert into finance.invoices (id, invoice_no, customer_id, issue_date, due_date, subtotal, discount_total, tax_total, total)
values ('90000000-0000-0000-0000-000000000001','INV-2026-000001','40000000-0000-0000-0000-000000000001', current_date, current_date + 30, 2000, 40, 274.40, 2234.40);
select test.expect_error($$update finance.invoices set total = 100, subtotal = 100, tax_total = 0, discount_total = 0 where id = '90000000-0000-0000-0000-000000000001'$$,
  'INVOICE_IMMUTABLE%', 'issued invoice amounts cannot be edited');
select test.expect_error($$delete from finance.invoices$$, 'APPEND_ONLY%', 'invoices cannot be deleted');
update finance.invoices set status = 'partially_paid' where id = '90000000-0000-0000-0000-000000000001';
select test.ok(true, 'invoice status may still change');
select test.ok((select count(*) from audit.audit_log where table_name = 'customers' and action = 'INSERT') = 2, 'customer inserts were audited');
select test.ok((select count(*) from audit.audit_log where table_name = 'orders' and action = 'UPDATE'
                and actor_user_id = '00000000-0000-0000-0000-0000000000a3') >= 2, 'order submissions audited with the acting user');
select test.ok((select count(*) from audit.security_events where event_type = 'role_granted') = 1, 'role grant raised a security event');
select test.expect_error($$delete from audit.audit_log$$, 'APPEND_ONLY%', 'audit log cannot be deleted');

\echo 'SMOKE TEST COMPLETE'
