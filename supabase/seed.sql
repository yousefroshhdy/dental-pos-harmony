-- Honest OS — local/CI seed. Runs on `supabase db reset` (and scripts/db-test.sh).
-- NEVER applied to production. Reference data lives in migrations instead.
--
-- Contents:
--   1. `tests` schema: helpers used by supabase/tests/database/*.test.sql
--   2. tests.load_fixture(): a small scenario company (synthetic data only)

create schema if not exists tests;
grant usage on schema tests to authenticated, anon;

-- Act as a given user for the rest of the transaction (like a request with that JWT).
create or replace function tests.authenticate_as(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  execute 'set local role authenticated';
end $$;

create or replace function tests.authenticate_anon() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role anon';
end $$;

create or replace function tests.clear_authentication() returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

grant execute on all functions in schema tests to authenticated, anon;

-- Well-known fixture ids (readable in tests):
--   users   …a1 owner · …a2 sales director · …a3 area mgr Cairo · …a4 rep Cairo · …a5 rep Delta
--           …a6 finance · …a7 admin · …a8 inventory mgr
--   customers 4…01 (Cairo/Nasr City, rep a4) · 4…02 (Delta, rep a5)
create or replace function tests.load_fixture() returns void
language plpgsql as $$
declare v_cai uuid; v_delta uuid;
begin
  select id into v_cai   from core.territories where code = 'CAI-GIZ';
  select id into v_delta from core.territories where code = 'DELTA';

  insert into core.territories (id, code, name_en, name_ar, level, parent_id) values
    ('10000000-0000-0000-0000-000000000003', 'CAI-NASR', 'Nasr City', 'مدينة نصر', 'area', v_cai);

  insert into auth.users (id, email) values
    ('00000000-0000-0000-0000-0000000000a1', 'owner@honest.test'),
    ('00000000-0000-0000-0000-0000000000a2', 'sd@honest.test'),
    ('00000000-0000-0000-0000-0000000000a3', 'am.cairo@honest.test'),
    ('00000000-0000-0000-0000-0000000000a4', 'rep.cairo@honest.test'),
    ('00000000-0000-0000-0000-0000000000a5', 'rep.delta@honest.test'),
    ('00000000-0000-0000-0000-0000000000a6', 'finance@honest.test'),
    ('00000000-0000-0000-0000-0000000000a7', 'admin@honest.test'),
    ('00000000-0000-0000-0000-0000000000a8', 'inventory@honest.test'),
    ('00000000-0000-0000-0000-0000000000a9', 'new.hire@honest.test');

  insert into core.employees (id, employee_no, user_id, full_name_en, job_title, manager_id) values
    ('20000000-0000-0000-0000-000000000001','E001','00000000-0000-0000-0000-0000000000a1','Owner','Company Owner',null),
    ('20000000-0000-0000-0000-000000000002','E002','00000000-0000-0000-0000-0000000000a2','Sales Director','Sales Director','20000000-0000-0000-0000-000000000001'),
    ('20000000-0000-0000-0000-000000000003','E003','00000000-0000-0000-0000-0000000000a3','Area Mgr Cairo','Area Manager','20000000-0000-0000-0000-000000000002'),
    ('20000000-0000-0000-0000-000000000004','E004','00000000-0000-0000-0000-0000000000a4','Rep Cairo','Sales Representative','20000000-0000-0000-0000-000000000003'),
    ('20000000-0000-0000-0000-000000000005','E005','00000000-0000-0000-0000-0000000000a5','Rep Delta','Sales Representative','20000000-0000-0000-0000-000000000002'),
    ('20000000-0000-0000-0000-000000000006','E006','00000000-0000-0000-0000-0000000000a6','Finance','Finance Officer','20000000-0000-0000-0000-000000000001'),
    ('20000000-0000-0000-0000-000000000007','E007','00000000-0000-0000-0000-0000000000a7','Admin','System Administrator','20000000-0000-0000-0000-000000000001'),
    ('20000000-0000-0000-0000-000000000008','E008','00000000-0000-0000-0000-0000000000a8','Inventory','Inventory Manager','20000000-0000-0000-0000-000000000001'),
    ('20000000-0000-0000-0000-000000000009','E009',null,'New Hire','Sales Representative','20000000-0000-0000-0000-000000000003');
  insert into core.user_profiles (user_id, employee_id)
    select user_id, id from core.employees where user_id is not null;
  insert into core.employee_territories (employee_id, territory_id, assignment) values
    ('20000000-0000-0000-0000-000000000003', v_cai, 'manager'),
    ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000003', 'member'),
    ('20000000-0000-0000-0000-000000000005', v_delta, 'member');

  insert into authz.user_roles (user_id, role_id)
  select v.uid::uuid, r.id from (values
    ('00000000-0000-0000-0000-0000000000a1','owner'),
    ('00000000-0000-0000-0000-0000000000a2','sales_director'),
    ('00000000-0000-0000-0000-0000000000a3','area_manager'),
    ('00000000-0000-0000-0000-0000000000a4','sales_rep'),
    ('00000000-0000-0000-0000-0000000000a5','sales_rep'),
    ('00000000-0000-0000-0000-0000000000a6','finance_officer'),
    ('00000000-0000-0000-0000-0000000000a7','admin'),
    ('00000000-0000-0000-0000-0000000000a8','inventory_manager')) v(uid, code)
  join authz.roles r on r.code = v.code;

  insert into crm.customers (id, customer_no, doctor_name, display_name, territory_id, lifecycle_stage,
                             phone_primary, latitude, longitude, governorate_code) values
    ('40000000-0000-0000-0000-000000000001','C-0001','Dr. Ahmed','Dr. Ahmed Clinic','10000000-0000-0000-0000-000000000003','active','+201001234567',30.044400,31.235700,'EG-C'),
    ('40000000-0000-0000-0000-000000000002','C-0002','Dr. Mona','Dr. Mona Clinic', v_delta,'active','+201112345678',31.040900,31.378500,'EG-DK');
  insert into crm.customer_assignments (customer_id, employee_id) values
    ('40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004'),
    ('40000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000005');

  insert into catalog.products (id, brand_id, category_id, code, name_en)
  select '52000000-0000-0000-0000-000000000001', b.id, c.id, 'BIO-TOP', 'Bioner Top DM'
  from catalog.brands b, catalog.categories c where b.code = 'BIONER' and c.code = 'IMPLANT';
  insert into catalog.product_variants (id, product_id, sku, name_en) values
    ('53000000-0000-0000-0000-000000000001','52000000-0000-0000-0000-000000000001','BIO-TOP-4110','Top DM 4.1x10');
  insert into catalog.product_costs (variant_id, unit_cost, effective_from) values
    ('53000000-0000-0000-0000-000000000001', 600, '2026-01-01');
  insert into catalog.price_lists (id, code, name, kind, valid_from) values
    ('54000000-0000-0000-0000-000000000001','DEFAULT','Default 2026','standard','2026-01-01');
  insert into catalog.price_list_items values
    ('54000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001', 1000, 1);

  insert into inventory.warehouses (id, code, name) values
    ('60000000-0000-0000-0000-000000000001','WH-CAI','Cairo main');
  insert into inventory.lots (id, variant_id, lot_no, expiry_date) values
    ('61000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','L2026A','2030-12-31');
end $$;
