-- CRM commands: customer creation (idempotency, hard/soft duplicates, territory and
-- owner rules), updates (whitelist, version conflicts, lifecycle), location,
-- activities, opportunities, reassignment workflow + hook, read views and masking.
begin;
select tests.load_fixture();
select plan(100);

-- ---------------------------------------------------------------------------
-- Extra fixture: a marketing director (crm.customer.read all, NO balance read),
-- territory coverage and opening balances.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000b1', 'marketing@honest.test');
insert into core.employees (id, employee_no, user_id, full_name_en, job_title, manager_id) values
  ('20000000-0000-0000-0000-000000000010','E010','00000000-0000-0000-0000-0000000000b1','Marketing','Marketing Director',
   '20000000-0000-0000-0000-000000000001');
insert into core.user_profiles (user_id, employee_id) values
  ('00000000-0000-0000-0000-0000000000b1','20000000-0000-0000-0000-000000000010');
insert into authz.user_roles (user_id, role_id)
  select '00000000-0000-0000-0000-0000000000b1', id from authz.roles where code = 'marketing_director';

insert into core.territory_coverage (territory_id, governorate_code, city) values
  ('10000000-0000-0000-0000-000000000003', 'EG-C', 'Nasr City'),
  ((select id from core.territories where code = 'CAI-GIZ'), 'EG-C', '*'),
  ((select id from core.territories where code = 'DELTA'), 'EG-DK', '*');

insert into finance.customer_ledger (customer_id, entry_type, amount, source_table, source_id) values
  ('40000000-0000-0000-0000-000000000001', 'opening_balance', 1500, 'test', 'b0000000-0000-0000-0000-000000000001'),
  ('40000000-0000-0000-0000-000000000002', 'opening_balance', 2500, 'test', 'b0000000-0000-0000-0000-000000000002');

-- ===========================================================================
-- create_customer
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select ok(set_config('t.r1', api.create_customer(p_doctor_name => 'Dr. Karim Adel', p_clinic_name => 'Smile Care Center',
  p_phone_primary => '010 1111-2222', p_governorate_code => 'eg-c', p_city => 'Nasr City', p_specialty_code => 'IMPLANTOLOGY',
  p_client_ref => 'c1000000-0000-0000-0000-000000000001')::text, true) like '{%', 'rep creates a customer');
select ok(current_setting('t.r1')::jsonb ->> 'customer_no' ~ ('^CUS-' || extract(year from current_date)::int || '-[0-9]{6}$'),
  'customer number comes from the CUS document series');
select is((current_setting('t.r1')::jsonb ->> 'territory_id')::uuid, '10000000-0000-0000-0000-000000000003'::uuid,
  'territory derived from governorate + city coverage');
select is((select phone_primary::text from crm.customers where id = (current_setting('t.r1')::jsonb ->> 'customer_id')::uuid),
  '+201011112222', 'local phone format is normalised to E.164');
select is((select lifecycle_stage from crm.customers where id = (current_setting('t.r1')::jsonb ->> 'customer_id')::uuid),
  'lead', 'new customer starts as a lead');
select is((select employee_id from crm.customer_assignments where customer_id = (current_setting('t.r1')::jsonb ->> 'customer_id')::uuid
           and role = 'primary_rep' and valid_to is null), '20000000-0000-0000-0000-000000000004'::uuid,
  'own-scoped creator becomes the primary rep');
select is(api.create_customer(p_doctor_name => 'Dr. Karim Adel', p_clinic_name => 'Smile Care Center',
  p_phone_primary => '010 1111-2222', p_governorate_code => 'eg-c', p_city => 'Nasr City',
  p_client_ref => 'c1000000-0000-0000-0000-000000000001') ->> 'customer_id',
  current_setting('t.r1')::jsonb ->> 'customer_id', 'replay with the same client_ref returns the same customer');
select is((select count(*)::int from crm.customers where client_ref = 'c1000000-0000-0000-0000-000000000001'), 1,
  'a replay creates nothing new');
select throws_like($$select api.create_customer(p_clinic_name => 'Other', p_phone_primary => '01001234567', p_governorate_code => 'EG-C')$$,
  'DUPLICATE_CUSTOMER%C-0001', 'same mobile as an active customer is a hard duplicate');
select throws_like($$select api.create_customer(p_clinic_name => 'X', p_phone_primary => '12345', p_governorate_code => 'EG-C')$$,
  'VALIDATION%phone_primary%', 'invalid phone is rejected');
select throws_like($$select api.create_customer(p_phone_primary => '01099998888', p_governorate_code => 'EG-C')$$,
  'VALIDATION: doctor_name or clinic_name is required', 'a customer needs a doctor or clinic name');
select throws_like($$select api.create_customer(p_clinic_name => 'X', p_phone_primary => '01099998888', p_governorate_code => 'XX')$$,
  'VALIDATION: unknown governorate%', 'unknown governorate is rejected');
select ok(set_config('t.r2', api.create_customer(p_clinic_name => 'Dr Ahmed Clinic', p_phone_primary => '01022223333',
  p_governorate_code => 'EG-C', p_city => 'Maadi')::text, true) like '{%', 'a similar name still creates the customer');
select ok((current_setting('t.r2')::jsonb #>> '{warnings,0,code}') = 'POSSIBLE_DUPLICATE'
          and (current_setting('t.r2')::jsonb #> '{warnings,0,customer_nos}') ? 'C-0001',
  'similar name in the same governorate returns a soft-duplicate warning with customer_no only');
select is((current_setting('t.r2')::jsonb ->> 'territory_id')::uuid, (select id from core.territories where code = 'CAI-GIZ'),
  'governorate-wide coverage (*) is the fallback when the city has no entry');
select ok(set_config('t.r3', api.create_customer(p_clinic_name => 'Alex Dental', p_phone_primary => '٠١٢٢٣٣٣٤٤٤٥',
  p_governorate_code => 'EG-ALX')::text, true) like '{%', 'customer in an uncovered governorate is created');
select is((current_setting('t.r3')::jsonb ->> 'territory_id')::uuid, '10000000-0000-0000-0000-000000000003'::uuid,
  'without coverage the caller''s own territory is used');
select is((select phone_primary::text from crm.customers where id = (current_setting('t.r3')::jsonb ->> 'customer_id')::uuid),
  '+201223334445', 'Arabic-Indic digits are normalised');
select throws_like($$select api.create_customer(p_clinic_name => 'T', p_phone_primary => '01055556666', p_governorate_code => 'EG-C',
  p_territory_id => (select id from core.territories where code = 'DELTA'))$$,
  'PERMISSION_DENIED: territory%', 'an own-scoped rep cannot choose a territory');
select throws_like($$select api.create_customer(p_clinic_name => 'T', p_phone_primary => '01055556666', p_governorate_code => 'EG-C',
  p_owner_employee_id => '20000000-0000-0000-0000-000000000005')$$,
  'PERMISSION_DENIED: employee%', 'an own-scoped rep cannot assign a customer to someone else');

-- Another rep hits the hard duplicate on a customer they cannot see: only customer_no leaks.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select throws_ok($$select api.create_customer(p_clinic_name => 'Copy', p_phone_primary => '+20 100 123 4567', p_governorate_code => 'EG-DK')$$,
  'P0001', 'DUPLICATE_CUSTOMER: phone is already registered to customer C-0001',
  'duplicate message reveals only the existing customer number');

-- Area manager (territory scope) may assign within the territory, not outside it.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(api.create_customer(p_clinic_name => 'Nile Dental', p_phone_primary => '01033334444', p_governorate_code => 'EG-C',
  p_city => 'nasr city', p_owner_employee_id => '20000000-0000-0000-0000-000000000004') ->> 'owner_employee_id',
  '20000000-0000-0000-0000-000000000004', 'area manager assigns a new customer to a rep in the territory');
select throws_like($$select api.create_customer(p_clinic_name => 'Delta Smile', p_phone_primary => '01077778888', p_governorate_code => 'EG-DK',
  p_owner_employee_id => '20000000-0000-0000-0000-000000000005')$$,
  'PERMISSION_DENIED: employee%', 'area manager cannot assign to a rep outside the territory');

-- Sales director (all scope) creates an unassigned lead routed by coverage.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select ok(set_config('t.r5', api.create_customer(p_doctor_name => 'Dr. Hana', p_phone_primary => '01044445555',
  p_governorate_code => 'EG-DK')::text, true) like '{%', 'director creates a lead');
select ok((current_setting('t.r5')::jsonb -> 'owner_employee_id') = 'null'::jsonb
          and (select count(*) from crm.customer_assignments where customer_id = (current_setting('t.r5')::jsonb ->> 'customer_id')::uuid) = 0
          and (current_setting('t.r5')::jsonb ->> 'territory_id')::uuid = (select id from core.territories where code = 'DELTA'),
  'a broad-scope creator without an owner leaves the lead unassigned in the covered territory');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_like($$select api.create_customer(p_clinic_name => 'X', p_phone_primary => '01099998888', p_governorate_code => 'EG-C')$$,
  'PERMISSION_DENIED: crm.customer.create', 'inventory manager cannot create customers');

select tests.clear_authentication();
select is((select count(*)::int from integration.outbox where event_type = 'customer.created'
           and aggregate_id = (current_setting('t.r1')::jsonb ->> 'customer_id')::uuid), 1,
  'customer.created is emitted once (not on replay)');
select ok(not exists (select 1 from integration.outbox where event_type = 'customer.created'
                      and (payload ? 'phone_primary' or payload ? 'latitude')),
  'customer.created payload carries no phone or GPS data');

-- ===========================================================================
-- update_customer
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.update_customer((current_setting('t.r1')::jsonb ->> 'customer_id')::uuid, 1,
  '{"notes": "Prefers morning visits", "lifecycle_stage": "prospect"}') ->> 'version', '2',
  'update bumps the version');
select is((select count(*)::int from crm.activities where customer_id = (current_setting('t.r1')::jsonb ->> 'customer_id')::uuid
           and type = 'stage_change' and summary like '%lead → prospect%'), 1, 'stage change writes a timeline activity');
select throws_like(format($$select api.update_customer(%L, 1, '{"notes": "something else"}')$$, current_setting('t.r1')::jsonb ->> 'customer_id'),
  'CONFLICT%', 'a stale version is rejected');
select is(api.update_customer((current_setting('t.r1')::jsonb ->> 'customer_id')::uuid, 1,
  '{"notes": "Prefers morning visits", "lifecycle_stage": "prospect"}') ->> 'changed', 'false',
  'replaying an already applied edit is a no-op, not a conflict');
select throws_like(format($$select api.update_customer(%L, 2, '{"territory_id": null, "credit_limit": 1}')$$, current_setting('t.r1')::jsonb ->> 'customer_id'),
  'VALIDATION%credit_limit, territory_id', 'territory and credit terms cannot be changed through update_customer');
select throws_like(format($$select api.update_customer(%L, 2, '{"lifecycle_stage": "blocked"}')$$, current_setting('t.r1')::jsonb ->> 'customer_id'),
  'INVALID_STATE%prospect to blocked', 'invalid lifecycle transition is rejected');
select throws_like($$select api.update_customer('40000000-0000-0000-0000-000000000002', 1, '{"notes": "x"}')$$,
  'PERMISSION_DENIED%', 'rep cannot update another rep''s customer');
select throws_like($$select api.update_customer('40000000-0000-0000-0000-0000000000ff', 1, '{"notes": "x"}')$$,
  'NOT_FOUND%', 'unknown customer is NOT_FOUND');
select throws_like(format($$select api.update_customer(%L, 2, '{"phone_primary": "01112345678"}')$$, current_setting('t.r1')::jsonb ->> 'customer_id'),
  'DUPLICATE_CUSTOMER%C-0002', 'changing to another customer''s phone is a hard duplicate');

-- ===========================================================================
-- set_customer_location
-- ===========================================================================
select throws_like($$select api.set_customer_location('40000000-0000-0000-0000-000000000001', 30.045, 31.236)$$,
  'PERMISSION_DENIED: crm.customer_location.verify', 'rep cannot move a clinic pin');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(api.set_customer_location('40000000-0000-0000-0000-000000000001', 30.045000, 31.236000) ->> 'location_verified', 'true',
  'area manager verifies a clinic location in the territory');
select throws_like($$select api.set_customer_location('40000000-0000-0000-0000-000000000001', 48.85, 2.35)$$,
  'VALIDATION%inside Egypt', 'coordinates outside Egypt are rejected');
select throws_like($$select api.set_customer_location('40000000-0000-0000-0000-000000000002', 31.04, 31.37)$$,
  'PERMISSION_DENIED%', 'area manager cannot set a location outside the territory');
select tests.clear_authentication();
select ok(exists (select 1 from audit.audit_log where table_name = 'customers' and action = 'UPDATE'
                  and record_id = '40000000-0000-0000-0000-000000000001' and changed_fields @> array['latitude']
                  and actor_user_id = '00000000-0000-0000-0000-0000000000a3'), 'location change is in the audit log');
select is((select count(*)::int from audit.security_events where event_type = 'customer_location_changed'), 1,
  'moving an existing pin raises a security event');

-- ===========================================================================
-- log_activity
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select ok(api.log_activity('40000000-0000-0000-0000-000000000001', 'call', 'Discussed the Bioner kit') ? 'activity_id',
  'rep logs a call on an own customer');
select throws_like($$select api.log_activity('40000000-0000-0000-0000-000000000001', 'order', 'fake order')$$,
  'VALIDATION%order%', 'system activity types cannot be logged manually');
select throws_like($$select api.log_activity('40000000-0000-0000-0000-000000000002', 'call', 'x')$$,
  'PERMISSION_DENIED%', 'rep cannot log on another rep''s customer');

-- ===========================================================================
-- Opportunities
-- ===========================================================================
select is(set_config('t.o1', api.create_opportunity('40000000-0000-0000-0000-000000000001', 'Bioner starter kit', 'bioner',
  25000, current_date + 30)::text, true)::jsonb ->> 'stage', 'new', 'rep creates an opportunity at stage new');
select is((select count(*)::int from work.tasks where ref_table = 'crm.opportunities'
           and ref_id = (current_setting('t.o1')::jsonb ->> 'opportunity_id')::uuid and due_at > now() + interval '2 days'), 1,
  'a follow-up task is created three days out');
select is(api.move_opportunity((current_setting('t.o1')::jsonb ->> 'opportunity_id')::uuid, 'proposal') ->> 'stage', 'proposal',
  'opportunity moves to proposal');
select throws_like(format($$select api.move_opportunity(%L, 'lost')$$, current_setting('t.o1')::jsonb ->> 'opportunity_id'),
  'REASON_REQUIRED%', 'lost needs a reason');
select throws_like($$select api.create_opportunity('40000000-0000-0000-0000-000000000002', 'Steal', null)$$,
  'PERMISSION_DENIED%', 'rep cannot open an opportunity on another rep''s customer');
select throws_like($$select api.create_opportunity('40000000-0000-0000-0000-000000000001', 'Unknown brand', 'ACME')$$,
  'NOT_FOUND: brand%', 'unknown brand is rejected');
select lives_ok(format($$select api.move_opportunity(%L, 'won')$$, current_setting('t.o1')::jsonb ->> 'opportunity_id'),
  'opportunity is won');
select ok((select stage = 'won' and closed_at is not null and probability_pct = 100 from crm.opportunities
           where id = (current_setting('t.o1')::jsonb ->> 'opportunity_id')::uuid), 'won opportunity is closed at 100%');
select throws_like(format($$select api.move_opportunity(%L, 'negotiation')$$, current_setting('t.o1')::jsonb ->> 'opportunity_id'),
  'INVALID_STATE%won to negotiation', 'won is terminal');
select set_config('t.o2', api.create_opportunity('40000000-0000-0000-0000-000000000001', 'RDT burs', 'RDT')::text, true) is not null as setup;
select is((api.move_opportunity((current_setting('t.o2')::jsonb ->> 'opportunity_id')::uuid, 'lost', 'price too high') ->> 'stage'), 'lost',
  'opportunity is lost with a reason');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select throws_like(format($$select api.move_opportunity(%L, 'qualified')$$, current_setting('t.o2')::jsonb ->> 'opportunity_id'),
  'PERMISSION_DENIED%', 'another rep cannot move the opportunity');
select tests.clear_authentication();
select is((select count(*)::int from integration.outbox where event_type in ('opportunity.won','opportunity.lost')), 2,
  'won/lost emit outbox events');

-- ===========================================================================
-- Read views and masking (before reassignment)
-- ===========================================================================
insert into crm.customer_contacts (customer_id, name, role) values
  ('40000000-0000-0000-0000-000000000001', 'Nurse Salma', 'assistant');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select balance from api.v_customers where customer_no = 'C-0001'), 1500.00::numeric, 'rep sees the balance of an own customer');
select is((select primary_rep_name_en from api.v_customers where customer_no = 'C-0001'), 'Rep Cairo', 'view shows the primary rep name');
select is((select count(*)::int from api.v_customers where customer_no = 'C-0002'), 0, 'rep cannot see another rep''s customer');
select is((select count(*)::int from api.v_opportunities), 2, 'rep sees own opportunities');
select ok((select count(*) from api.v_customer_timeline where customer_id = '40000000-0000-0000-0000-000000000001') >= 3,
  'rep sees the customer timeline');
select is((select count(*)::int from crm.customer_contacts), 1, 'rep sees contacts of own customers');
select is((select balance from api.v_customers where id = (current_setting('t.r1')::jsonb ->> 'customer_id')::uuid), 0.00::numeric,
  'a customer without ledger rows shows a zero balance to authorised users');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000b1');
select is((select balance is null and credit_limit is null and payment_terms_days is null from api.v_customers where customer_no = 'C-0001'),
  true, 'balance and credit terms are masked without crm.customer_balance.read');
select is((select count(*)::int from api.v_opportunities), 2, 'marketing director reads all opportunities');
select is((select count(*)::int from crm.customer_balances_in_scope()), 0, 'calling the balance helper directly reveals nothing');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select balance from api.v_customers where customer_no = 'C-0002'), 2500.00::numeric, 'finance sees every balance');
select is((select count(*)::int from api.v_opportunities), 0, 'finance has no opportunity access');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select balance from api.v_customers where customer_no = 'C-0001'), 1500.00::numeric, 'area manager sees territory balances');
select is((select count(*)::int from api.v_customers where customer_no = 'C-0002'), 0, 'area manager does not see Delta customers');
select is((select count(*)::int from api.v_opportunities), 2, 'area manager sees territory opportunities');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from api.v_opportunities), 0, 'another rep sees no opportunities');
select is((select count(*)::int from api.v_customer_timeline where customer_id = '40000000-0000-0000-0000-000000000001'), 0,
  'another rep cannot read the timeline');
select is((select count(*)::int from crm.customer_contacts), 0, 'another rep cannot read contacts');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from api.v_customers), 7, 'sales director sees every customer');

-- ===========================================================================
-- Reassignment workflow
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(set_config('t.q1', api.request_customer_reassignment('40000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000005', 'Doctor moved to Mansoura branch')::text, true)::jsonb ->> 'status', 'pending',
  'rep requests a reassignment');
select throws_like($$select api.request_customer_reassignment('40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', 'again')$$,
  'INVALID_STATE%already pending%', 'only one pending reassignment per customer');
select throws_like(format($$select api.request_customer_reassignment(%L, '20000000-0000-0000-0000-000000000005', '  ')$$,
  current_setting('t.r1')::jsonb ->> 'customer_id'), 'REASON_REQUIRED%', 'a reason is required');
select throws_like(format($$select api.request_customer_reassignment(%L, '20000000-0000-0000-0000-000000000004', 'self')$$,
  current_setting('t.r1')::jsonb ->> 'customer_id'), 'INVALID_STATE%already the primary%', 'cannot reassign to the current rep');
select throws_like(format($$select wf.on_decided_crm_customer_reassign(%L, true)$$, current_setting('t.q1')::jsonb ->> 'approval_request_id'),
  '%permission denied%', 'app users cannot call the approval hook');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select throws_like($$select api.request_customer_reassignment('40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000005', 'mine')$$,
  'PERMISSION_DENIED%', 'a rep cannot request a customer they cannot read');

select tests.clear_authentication();
select ok((select payload ->> 'from_employee_id' = '20000000-0000-0000-0000-000000000004'
              and payload ->> 'to_employee_id' = '20000000-0000-0000-0000-000000000005'
              and entity_type = 'crm.customer'
           from wf.approval_requests where id = (current_setting('t.q1')::jsonb ->> 'approval_request_id')::uuid),
  'approval payload freezes from/to employees');
select lives_ok(format($$select wf.on_decided_crm_customer_reassign(%L, true)$$, current_setting('t.q1')::jsonb ->> 'approval_request_id'),
  'approval hook applies the reassignment');
select is((select employee_id from crm.customer_assignments where customer_id = '40000000-0000-0000-0000-000000000001'
           and role = 'primary_rep' and valid_to is null), '20000000-0000-0000-0000-000000000005'::uuid, 'new primary rep is open');
select is((select count(*)::int from crm.customer_assignments where customer_id = '40000000-0000-0000-0000-000000000001'
           and employee_id = '20000000-0000-0000-0000-000000000004' and valid_to is not null), 1, 'old assignment is closed, not deleted');
select is((select count(*)::int from integration.outbox where event_type = 'customer.reassigned'
           and aggregate_id = '40000000-0000-0000-0000-000000000001'), 1, 'customer.reassigned is emitted');
select is((select count(*)::int from notify.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000a5'
           and type = 'customer.assigned'), 1, 'the new rep is notified');
select lives_ok(format($$select wf.on_decided_crm_customer_reassign(%L, true)$$, current_setting('t.q1')::jsonb ->> 'approval_request_id'),
  'hook is idempotent');
select is((select count(*)::int from crm.customer_assignments where customer_id = '40000000-0000-0000-0000-000000000001'
           and role = 'primary_rep'), 2, 're-running the hook changes nothing');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from api.v_customers where customer_no = 'C-0001'), 0, 'old rep loses access after reassignment');
select is(set_config('t.q2', api.request_customer_reassignment((current_setting('t.r1')::jsonb ->> 'customer_id')::uuid,
  '20000000-0000-0000-0000-000000000005', 'trial')::text, true)::jsonb ->> 'status', 'pending', 'second reassignment requested');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select balance from api.v_customers where customer_no = 'C-0001'), 1500.00::numeric, 'new rep sees the customer and balance');

select tests.clear_authentication();
select lives_ok(format($$select wf.on_decided_crm_customer_reassign(%L, false)$$, current_setting('t.q2')::jsonb ->> 'approval_request_id'),
  'rejection hook runs');
select is((select employee_id from crm.customer_assignments where customer_id = (current_setting('t.r1')::jsonb ->> 'customer_id')::uuid
           and role = 'primary_rep' and valid_to is null), '20000000-0000-0000-0000-000000000004'::uuid, 'rejection keeps the current rep');
select throws_like(format($$select wf.on_decided_field_visit_exception(%L, true)$$, current_setting('t.q2')::jsonb ->> 'approval_request_id'),
  'INVALID_STATE%not a visit exception', 'a hook refuses requests of another workflow');

-- Privilege surface
select ok(not has_function_privilege('authenticated', 'wf.on_decided_crm_customer_reassign(uuid, boolean)', 'execute')
          and not has_function_privilege('anon', 'wf.on_decided_crm_customer_reassign(uuid, boolean)', 'execute'),
  'reassignment hook is not executable by app roles');
select ok(not has_function_privilege('authenticated', 'crm._emit(text, text, uuid, jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'crm._add_activity(uuid, uuid, text, text, text, uuid, timestamptz)', 'execute')
          and not has_function_privilege('authenticated', 'crm._notify_employee(uuid, text, text, text, text, jsonb)', 'execute'),
  'internal writers are not executable by app users');
select ok(has_function_privilege('authenticated', 'api.create_customer(text, text, text, text, text, text, text, text, text, text, text, text[], text, uuid, uuid, uuid, text)', 'execute')
          and not has_function_privilege('anon', 'api.create_customer(text, text, text, text, text, text, text, text, text, text, text, text[], text, uuid, uuid, uuid, text)', 'execute'),
  'create_customer is executable by authenticated only');

select * from finish();
rollback;
