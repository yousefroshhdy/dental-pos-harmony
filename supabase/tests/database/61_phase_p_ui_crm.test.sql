-- Phase P step 2b (redesign of Today and CRM): api.v_customer_list, the read view behind the
-- redesigned customers list. Same rows as api.v_customers (RLS), archived customers left out,
-- phone/location gap flags that agree with api.v_customer_data_gaps, and an overdue flag that is
-- masked exactly like the balance. Also the "add the phone on the next visit" path the detail and
-- check-in screens use (api.update_customer with only phone_primary). Synthetic data only.
begin;
select tests.load_fixture();
select plan(30);

-- Fixture: E004 rep Cairo (a4, CAI-NASR, manager E003 = area manager a3); E005 rep Delta (a5).
-- C-0001 (a4) and C-0002 (a5) have a phone and a pin. Added: three synthetic clinics of rep a4,
-- one archived, and a marketing director (crm.customer.read everywhere, no balance read).
insert into crm.customers (id, customer_no, doctor_name, display_name, territory_id, lifecycle_stage, phone_primary) values
  ('40000000-0000-0000-0000-0000000061a1', 'C-61A1', 'Dr. Synthetic Gap', 'Synthetic Gap Clinic',
   '10000000-0000-0000-0000-000000000003', 'lead', null),
  ('40000000-0000-0000-0000-0000000061a2', 'C-61A2', 'Dr. Synthetic Pin', 'Synthetic Unpinned Clinic',
   '10000000-0000-0000-0000-000000000003', 'prospect', '+201000006102'),
  ('40000000-0000-0000-0000-0000000061a3', 'C-61A3', 'Dr. Synthetic Old', 'Synthetic Archived Clinic',
   '10000000-0000-0000-0000-000000000003', 'lost', null);
update crm.customers set archived_at = now() where id = '40000000-0000-0000-0000-0000000061a3';
insert into crm.customer_assignments (customer_id, employee_id) values
  ('40000000-0000-0000-0000-0000000061a1', '20000000-0000-0000-0000-000000000004'),
  ('40000000-0000-0000-0000-0000000061a2', '20000000-0000-0000-0000-000000000004'),
  ('40000000-0000-0000-0000-0000000061a3', '20000000-0000-0000-0000-000000000004');
-- An invoice 12 days overdue for C-0001, one not yet due for C-61A2.
insert into finance.invoices (id, invoice_no, customer_id, issue_date, due_date, subtotal, total) values
  ('61300000-0000-0000-0000-000000000001', 'INV-61-0001', '40000000-0000-0000-0000-000000000001',
   core.business_date() - 42, core.business_date() - 12, 700, 700),
  ('61300000-0000-0000-0000-000000000002', 'INV-61-0002', '40000000-0000-0000-0000-0000000061a2',
   core.business_date() - 3, core.business_date() + 27, 300, 300);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000061b1', 'marketing61@honest.test');
insert into core.employees (id, employee_no, user_id, full_name_en, job_title, manager_id) values
  ('20000000-0000-0000-0000-0000000061b1', 'E61B1', '00000000-0000-0000-0000-0000000061b1', 'Marketing 61',
   'Marketing Director', '20000000-0000-0000-0000-000000000001');
insert into core.user_profiles (user_id, employee_id) values
  ('00000000-0000-0000-0000-0000000061b1', '20000000-0000-0000-0000-0000000061b1');
insert into authz.user_roles (user_id, role_id)
  select '00000000-0000-0000-0000-0000000061b1', id from authz.roles where code = 'marketing_director';

-- ===========================================================================
-- Structure and privileges
-- ===========================================================================
select ok((select coalesce(c.reloptions @> array['security_invoker=true'], false) from pg_class c
           where c.oid = 'api.v_customer_list'::regclass),
  'api.v_customer_list is security_invoker');
select ok(has_table_privilege('authenticated', 'api.v_customer_list', 'select'),
  'signed-in users can read the list view');
select ok(not has_table_privilege('anon', 'api.v_customer_list', 'select'),
  'anon cannot read the list view');
select ok(not has_table_privilege('authenticated', 'api.v_customer_list', 'insert')
          and not has_table_privilege('authenticated', 'api.v_customer_list', 'update')
          and not has_table_privilege('authenticated', 'api.v_customer_list', 'delete'),
  'the list view is read-only');

-- ===========================================================================
-- Scope: the same live customers as api.v_customers, per role
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select string_agg(customer_no, ',' order by customer_no) from api.v_customer_list), 'C-0001,C-61A1,C-61A2',
  'rep: their own live customers (not Delta, not archived)');
select is((select string_agg(customer_no, ',' order by customer_no) from api.v_customer_list),
          (select string_agg(customer_no, ',' order by customer_no) from api.v_customers where archived_at is null),
  'rep: exactly the live rows of api.v_customers');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select string_agg(customer_no, ',' order by customer_no) from api.v_customer_list), 'C-0001,C-61A1,C-61A2',
  'area manager: the customers of their territory tree');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select string_agg(customer_no, ',' order by customer_no) from api.v_customer_list), 'C-0002',
  'the Delta rep sees only Delta');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from api.v_customer_list), 4, 'owner: every live customer, the archived one excluded');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is((select count(*)::int from api.v_customer_list), 0, 'inventory manager (no crm.customer.read): no rows');

-- ===========================================================================
-- Data-gap flags (agree with api.v_customer_data_gaps)
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select ok((select phone_missing and location_missing from api.v_customer_list where customer_no = 'C-61A1'),
  'no phone and no pin: both gaps flagged');
select ok((select not phone_missing and location_missing from api.v_customer_list where customer_no = 'C-61A2'),
  'phone but no pin: location missing only');
select ok((select not phone_missing and not location_missing from api.v_customer_list where customer_no = 'C-0001'),
  'phone and pin: no gaps');
select is((select count(*)::int from api.v_customer_list l
           join api.v_customer_data_gaps g on g.customer_id = l.id
           where g.phone_missing = l.phone_missing and g.location_missing = l.location_missing), 2,
  'each gap row agrees with api.v_customer_data_gaps');
select is((select count(*)::int from api.v_customer_list l
           where (l.phone_missing or l.location_missing)
             and not exists (select 1 from api.v_customer_data_gaps g where g.customer_id = l.id)), 0,
  'no customer has a gap that api.v_customer_data_gaps misses');
select is((select string_agg(customer_no, ',' order by customer_no) from api.v_customer_list where phone_missing), 'C-61A1',
  'the "phone missing" filter');

-- ===========================================================================
-- Overdue flag, masked like the balance
-- ===========================================================================
select ok((select is_overdue and overdue_amount = 700.00 and max_days_overdue = 12
           from api.v_customer_list where customer_no = 'C-0001'),
  'rep: overdue flag, amount and days of an own customer');
select ok((select is_overdue is false and overdue_amount = 0.00 and max_days_overdue is null
           from api.v_customer_list where customer_no = 'C-61A2'),
  'rep: an invoice that is not yet due is not overdue (false, not masked)');
select is((select string_agg(customer_no, ',' order by customer_no) from api.v_customer_list where is_overdue), 'C-0001',
  'the "overdue" filter');
select is((select count(*)::int from api.v_customer_list where is_overdue and phone_missing), 0,
  'filters combine (overdue AND phone missing)');
select is((select is_overdue from api.v_customer_list where customer_no = 'C-0001'),
          (select is_overdue from api.v_customer_map where customer_no = 'C-0001'),
  'the overdue flag matches the customers map');

select tests.authenticate_as('00000000-0000-0000-0000-0000000061b1');
select is((select count(*)::int from api.v_customer_list), 4, 'marketing director reads every live customer');
select ok((select bool_and(balance is null and is_overdue is null and overdue_amount is null and max_days_overdue is null)
           from api.v_customer_list),
  'without crm.customer_balance.read the balance and the overdue flag are masked');
select is((select count(*)::int from api.v_customer_list where is_overdue), 0,
  'a masked overdue flag never matches the "overdue" filter');
select ok((select phone_missing from api.v_customer_list where customer_no = 'C-61A1'),
  'gap flags are not masked (they say what to collect, not money)');

-- ===========================================================================
-- Add the phone on the next visit (api.update_customer with only phone_primary)
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((api.update_customer('40000000-0000-0000-0000-0000000061a1',
                               (select version from api.v_customers where customer_no = 'C-61A1'),
                               '{"phone_primary": "0100 000 6101"}'::jsonb) ->> 'changed'), 'true',
  'the rep adds the missing phone of an own customer');
select ok((select phone_primary = '+201000006101' and not phone_missing from api.v_customer_list where customer_no = 'C-61A1'),
  'the phone is stored in E.164 and the gap is closed');
select throws_like($$select api.update_customer('40000000-0000-0000-0000-0000000061a2',
                       (select version from api.v_customers where customer_no = 'C-61A2'),
                       '{"phone_primary": "+201000006101"}'::jsonb)$$,
  'DUPLICATE_CUSTOMER%', 'a phone that belongs to another customer is refused');
select throws_like($$select api.update_customer('40000000-0000-0000-0000-0000000061a1',
                       (select version from api.v_customers where customer_no = 'C-61A1'),
                       '{"phone_primary": ""}'::jsonb)$$,
  'VALIDATION%', 'a phone cannot be removed again');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select throws_like($$select api.update_customer('40000000-0000-0000-0000-0000000061a2', 1,
                       '{"phone_primary": "01000006199"}'::jsonb)$$,
  'PERMISSION_DENIED%', 'another rep cannot add a phone to a customer outside their scope');

select * from finish();
rollback;
