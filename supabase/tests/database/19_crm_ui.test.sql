-- CRM UI read surface (migration 20261030000100): reference views, reassignment
-- targets and the duplicate pre-check. Allowed roles, denied roles and scope.
begin;
select tests.load_fixture();
select plan(26);

-- ---------------------------------------------------------------------------
-- Reference views
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from api.v_governorates), 27, 'a rep reads all 27 governorates');
select is((select name_ar from api.v_governorates where code = 'EG-C'), 'القاهرة', 'governorates carry Arabic names');
select ok((select count(*)::int from api.v_specialties) >= 9, 'a rep reads the specialties');

select tests.authenticate_anon();
select throws_like($$select count(*) from api.v_governorates$$, '%permission denied%', 'anon cannot read governorates');
select throws_like($$select count(*) from api.v_specialties$$, '%permission denied%', 'anon cannot read specialties');

-- A suspended login sees no reference data (RLS: active users only).
select tests.clear_authentication();
update core.user_profiles set status = 'suspended' where user_id = '00000000-0000-0000-0000-0000000000a5';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from api.v_governorates), 0, 'a suspended user reads no governorates');
select is((select count(*)::int from api.v_crm_assignable_employees), 0, 'a suspended user reads no colleagues');

-- ---------------------------------------------------------------------------
-- Reassignment targets
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select ok((select count(*)::int from api.v_employees) <= 1, 'a rep sees at most themselves in api.v_employees');
select ok(exists (select 1 from api.v_crm_assignable_employees where id = '20000000-0000-0000-0000-000000000003'),
  'a rep can pick their area manager as a reassignment target');
select ok(not exists (select 1 from api.v_crm_assignable_employees where id = '20000000-0000-0000-0000-000000000009'),
  'an employee without a login is not a target');
select ok(not exists (select 1 from api.v_crm_assignable_employees where id = '20000000-0000-0000-0000-000000000005'),
  'an employee whose login is suspended is not a target');
select is((select count(*)::int from api.v_crm_assignable_employees), 7,
  'targets are the active employees with an active login');
select is((select string_agg(column_name::text, ',' order by ordinal_position) from information_schema.columns
           where table_schema = 'api' and table_name = 'v_crm_assignable_employees'),
  'id,employee_no,full_name_en,full_name_ar,job_title', 'targets expose identity and job title only');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is((select count(*)::int from api.v_crm_assignable_employees), 0,
  'a user without crm.customer.read sees no targets');

select tests.authenticate_anon();
select throws_like($$select count(*) from api.v_crm_assignable_employees$$, '%permission denied%',
  'anon cannot read targets');
select tests.clear_authentication();
select ok(not has_function_privilege('anon', 'crm.assignable_employees()', 'execute'),
  'anon cannot execute the target helper');

-- ---------------------------------------------------------------------------
-- Duplicate pre-check
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.find_duplicate_customers(p_clinic_name => 'Dr Ahmed Clinic', p_phone_primary => '01099990000',
  p_governorate_code => 'eg-c') #>> '{similar_customer_nos,0}', 'C-0001',
  'a similar name in the same governorate is reported by customer number');
select is((api.find_duplicate_customers(p_clinic_name => 'Dr Ahmed Clinic', p_phone_primary => '01099990000',
  p_governorate_code => 'EG-C') ->> 'similar_count')::int, 1, 'the similar count is returned');
select ok(api.find_duplicate_customers(p_clinic_name => 'Dr Ahmed Clinic', p_phone_primary => '01099990000',
  p_governorate_code => 'EG-C') -> 'phone_duplicate_customer_no' = 'null'::jsonb, 'a new phone is not a hard duplicate');
select is((api.find_duplicate_customers(p_clinic_name => 'Dr Ahmed Clinic', p_phone_primary => '01099990000',
  p_governorate_code => 'EG-ALX') ->> 'similar_count')::int, 0, 'another governorate is not a soft duplicate');
select is(api.find_duplicate_customers(p_clinic_name => 'Brand New Dental', p_phone_primary => '010 0123-4567',
  p_governorate_code => 'EG-C') ->> 'phone_duplicate_customer_no', 'C-0001',
  'the same phone in local format is a hard duplicate');

-- The other rep cannot read C-0002's record, yet the pre-check reports its number only.
select tests.clear_authentication();
update core.user_profiles set status = 'active' where user_id = '00000000-0000-0000-0000-0000000000a5';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from api.v_customers where customer_no = 'C-0002'), 0, 'the Cairo rep cannot read C-0002');
-- Audit Phase 3 F7 (suite 25): an out-of-scope match is only a flag, never a customer number.
select is(api.find_duplicate_customers(p_clinic_name => 'Dr. Mona Clinic', p_governorate_code => 'EG-DK')::jsonb
            - 'phone_duplicate_customer_no' - 'phone_duplicate_outside_scope',
  '{"similar_count": 0, "similar_customer_nos": [], "similar_outside_scope": true, "exists_outside_scope": true}'::jsonb,
  'an out-of-scope duplicate is reported only as a flag');

select throws_like($$select api.find_duplicate_customers(p_clinic_name => 'X', p_phone_primary => '12345', p_governorate_code => 'EG-C')$$,
  'VALIDATION%phone_primary%', 'an invalid phone is a validation error');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_ok($$select api.find_duplicate_customers(p_clinic_name => 'Dr Ahmed Clinic', p_governorate_code => 'EG-C')$$,
  '42501', null, 'a user without crm.customer.create is denied');

select tests.clear_authentication();
select ok(not has_function_privilege('anon', 'api.find_duplicate_customers(text, text, text, text, text)', 'execute'),
  'anon cannot execute the pre-check');

select * from finish();
rollback;
