-- Admin console v2 (migrations 20261103000800 settings, 0810 employees, 0820 territories):
--   settings whitelist, types and ranges, owner-only keys, audit + outbox (no values)
--   employees: update, scope, manager-chain cycles, status changes, held customers, territories
--   territories: create / rename / move (cycles, depth), deactivate, coverage, customer counts
--   non-admins denied (42501); every new definer function pins search_path and is closed to anon
begin;
select tests.load_fixture();
set constraints all immediate;
select plan(113);

-- Fixture: a1 owner (E001) · a2 sales director (E002) · a3 area mgr Cairo (E003, team read) ·
-- a4 rep Cairo (E004, reports to E003) · a5 rep Delta (E005) · a7 admin (E007) · E009 new hire (no login).

-- ===========================================================================
-- 1. Privileges of every new function
-- ===========================================================================
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where p.oid in (
             'api.update_setting(text, jsonb, text, timestamptz)'::regprocedure,
             'api.update_employee(uuid, text, text, text, text, text, uuid, uuid, uuid, date, timestamptz)'::regprocedure,
             'api.employee_customer_holdings(uuid)'::regprocedure,
             'api.set_employment_status(uuid, text, text, date)'::regprocedure,
             'api.assign_employee_territory(uuid, uuid, text)'::regprocedure,
             'api.end_employee_territory(uuid, text)'::regprocedure,
             'api.create_territory(text, text, text, uuid)'::regprocedure,
             'api.rename_territory(uuid, text, text)'::regprocedure,
             'api.move_territory(uuid, uuid, text)'::regprocedure,
             'api.set_territory_active(uuid, boolean, text)'::regprocedure,
             'api.set_territory_coverage(uuid, text, text)'::regprocedure,
             'api.remove_territory_coverage(text, text)'::regprocedure,
             'api.territory_customer_counts()'::regprocedure)
             and p.prosecdef
             and p.proconfig @> array['search_path=""']
             and not has_function_privilege('anon', p.oid, 'execute')
             and has_function_privilege('authenticated', p.oid, 'execute')
             and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')),
          13, 'the 13 new api commands are definer, pin search_path, are closed to PUBLIC and anon, open to authenticated');
select is((select count(*)::int from pg_proc p
           where p.oid in (
             'core.validate_setting_value(text, jsonb)'::regprocedure,
             'core.employee_in_scope(text, uuid)'::regprocedure,
             'core.user_holds_owner_role(uuid)'::regprocedure,
             'core.employee_held_customers(uuid)'::regprocedure,
             'core.check_territory_assignment(uuid, uuid)'::regprocedure,
             'core.guard_manager_cycle()'::regprocedure,
             'core.guard_last_owner_employment()'::regprocedure,
             'core.territory_depth(uuid)'::regprocedure,
             'core.territory_height(uuid)'::regprocedure,
             'core.territory_level_for_depth(int)'::regprocedure,
             'core.guard_territory_cycle()'::regprocedure,
             'core.territory_in_scope(uuid)'::regprocedure,
             'core.emit_territory_event(text, uuid, jsonb)'::regprocedure)
             and p.proconfig @> array['search_path=""']
             and not has_function_privilege('authenticated', p.oid, 'execute')
             and not has_function_privilege('anon', p.oid, 'execute')),
          13, 'the 13 internal helpers pin search_path and are not client-callable');
select ok((select bool_and(c.reloptions @> array['security_invoker=true'])
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'api' and c.relname in ('v_settings','v_admin_employees','v_employee_territories',
                                                     'v_departments','v_offices','v_territory_coverage')),
  'the new views are security_invoker');

-- ===========================================================================
-- 2. Settings
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select ok((select count(*) from api.v_settings) >= 26, 'the admin reads every setting');
select ok((select bool_and(is_whitelisted) from api.v_settings), 'every stored setting has a definition');
select is((select value from api.v_settings where key = 'field.geofence_radius_m'), '150'::jsonb, 'current value shown');
select ok((select is_default from api.v_settings where key = 'field.geofence_radius_m'), 'and flagged as the default');

select is(api.update_setting('field.geofence_radius_m', '200', 'wider clinics') ->> 'changed', 'true', 'admin changes an ordinary setting');
select is((select value from core.system_settings where key = 'field.geofence_radius_m'), '200'::jsonb, 'the value is stored');
select is((select updated_by from core.system_settings where key = 'field.geofence_radius_m'),
          '00000000-0000-0000-0000-0000000000a7'::uuid, 'with who changed it');
select is(api.update_setting('field.geofence_radius_m', '200') ->> 'changed', 'false', 'the same value again is a no-op');
select throws_like($$select api.update_setting('field.geofence_radius_m', '10')$$, 'SETTING_OUT_OF_RANGE%', 'below the minimum is refused');
select throws_like($$select api.update_setting('field.geofence_radius_m', '5000')$$, 'SETTING_OUT_OF_RANGE%', 'above the maximum is refused');
select throws_like($$select api.update_setting('field.geofence_radius_m', '150.5')$$, 'VALIDATION%', 'an integer setting refuses decimals');
select throws_like($$select api.update_setting('field.geofence_radius_m', '"150"')$$, 'VALIDATION%', 'a string is not a number');
select throws_like($$select api.update_setting('field.geofence_radius_m', 'null')$$, 'VALIDATION%', 'null is refused');
select throws_like($$select api.update_setting('no.such_key', '1')$$, 'SETTING_NOT_WHITELISTED%', 'an unknown key is refused');
select throws_like($$select api.update_setting('company.name', '"sk_live_0123456789abcdef"')$$, 'SETTING_SECRET_REFUSED%',
  'a text value shaped like an API key is refused');
select throws_like($$select api.update_setting('company.currency', '"USD"')$$, 'OWNER_ONLY%',
  'fixed company keys are owner-only');
select is(api.update_setting('company.name', '"  Honest Test Co  "') -> 'value', '"Honest Test Co"'::jsonb, 'text is trimmed');
select throws_like($$select api.update_setting('offline.max_queue_age_days', '8', null, '2000-01-01T00:00:00Z')$$, 'CONFLICT%',
  'a stale editor gets CONFLICT');

-- Owner-only families: tracking.*, finance.payment.*, commission.*, sales VAT, retention.
select throws_ok($$select api.update_setting('tracking.sample_interval_s', '600')$$, '42501', null, 'admin cannot change tracking.*');
select throws_like($$select api.update_setting('finance.payment.max_backdate_days_rep', '5')$$, 'OWNER_ONLY%', 'nor finance.payment.*');
select throws_like($$select api.update_setting('commission.clawback_days', '60')$$, 'OWNER_ONLY%', 'nor commission.*');
select throws_like($$select api.update_setting('sales.default_vat_pct', '10')$$, 'OWNER_ONLY%', 'nor the VAT default');
select tests.clear_authentication();
select throws_like($$insert into core.setting_definitions (key, group_code, value_type, default_value, owner_only,
                       label_en, label_ar, description_en, description_ar)
                     values ('security.example_flag', 'security', 'boolean', 'true', false, 'x', 'x', 'x', 'x')$$,
  '%setting_definitions_check%', 'a security.* definition cannot be created as admin-changeable');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.update_setting('tracking.sample_interval_s', '600', 'battery') -> 'value', '600'::jsonb, 'the owner changes tracking.*');
select is(api.update_setting('tracking.work_days', '["thu","sun","mon","sun"]') -> 'value', '["sun","mon","thu"]'::jsonb,
  'a weekday list is de-duplicated and put in week order');
select throws_like($$select api.update_setting('tracking.work_days', '["sun","funday"]')$$, 'VALIDATION%', 'an unknown weekday is refused');
select throws_like($$select api.update_setting('tracking.work_days', '[]')$$, 'SETTING_OUT_OF_RANGE%', 'at least one working day');
select is(api.update_setting('tracking.work_hours', '{"start":"08:30","end":"16:30"}') -> 'value',
          '{"start":"08:30","end":"16:30"}'::jsonb, 'a working-day range is accepted');
select throws_like($$select api.update_setting('tracking.work_hours', '{"start":"17:00","end":"09:00"}')$$, 'SETTING_OUT_OF_RANGE%',
  'the day must start before it ends');
select throws_like($$select api.update_setting('tracking.work_hours', '{"start":"9am","end":"17:00"}')$$, 'VALIDATION%', 'times are HH:MM');
select is(api.update_setting('sales.default_vat_pct', '14.5') -> 'value', '14.5'::jsonb, 'a number setting keeps two decimals');
select throws_like($$select api.update_setting('sales.default_vat_pct', '14.555')$$, 'VALIDATION%', 'but no more');
select throws_like($$select api.update_setting('company.timezone', '"Europe/Paris"')$$, 'SETTING_READ_ONLY%',
  'the business time zone is fixed even for the owner');
select tests.clear_authentication();

select is((select count(*)::int from audit.audit_log where table_schema = 'core' and table_name = 'system_settings' and action = 'UPDATE'
            and new_data ->> 'key' in ('field.geofence_radius_m','tracking.sample_interval_s')), 2, 'each change is in the audit log');
select is((select severity from audit.security_events where event_type = 'setting_changed'
            and details ->> 'key' = 'tracking.sample_interval_s'), 'critical', 'an owner-only change is a critical security event');
select ok((select details -> 'old' = '150'::jsonb and details -> 'new' = '200'::jsonb and details ->> 'reason' = 'wider clinics'
           from audit.security_events where event_type = 'setting_changed' and details ->> 'key' = 'field.geofence_radius_m'),
  'the security event keeps the old value, the new value and the reason');
select is((select count(*)::int from integration.outbox where event_type = 'setting.updated'), 6,
  'each real change (not the no-op) emits setting.updated');
select ok((select bool_and(not (payload ? 'value') and not (payload ? 'old') and not (payload ? 'new') and payload ? 'key')
           from integration.outbox where event_type = 'setting.updated'),
  'the outbox payload carries the key, never a value');

-- Non-admins
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.update_setting('field.geofence_radius_m', '300')$$, '42501', null, 'a rep cannot change settings');
select is((select count(*)::int from api.v_settings), 0, 'and reads no settings');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select throws_ok($$select api.update_setting('offline.max_queue_age_days', '9')$$, '42501', null, 'nor can the sales director');
select tests.authenticate_anon();
select throws_like($$select api.update_setting('offline.max_queue_age_days', '9')$$, '%permission denied%', 'anon cannot call it at all');
select tests.clear_authentication();

-- ===========================================================================
-- 3. Employees
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select ok((select count(*) from api.v_admin_employees) >= 9, 'the admin lists every employee');
select is((select direct_reports from api.v_admin_employees where id = '20000000-0000-0000-0000-000000000003'), 2,
  'direct reports are counted (E004, E009)');
select is(api.update_employee('20000000-0000-0000-0000-000000000009', 'New Hire', 'Senior Sales Representative',
            null, '+201012345678', null, null, null, '20000000-0000-0000-0000-000000000003') -> 'changed',
          '["job_title", "phone"]'::jsonb, 'admin updates a job title and phone (changed fields reported)');
select throws_ok($$select api.update_employee('20000000-0000-0000-0000-000000000009', 'New Hire', 'Rep', null, '12345')$$,
  '23514', null, 'an invalid phone is refused');

-- Cycle prevention: E002 → E003 → E004. Making E002 report to E004 closes a loop.
select throws_like($$select api.update_employee('20000000-0000-0000-0000-000000000002', 'Sales Director', 'Sales Director',
                       null, null, null, null, null, '20000000-0000-0000-0000-000000000004')$$, 'MANAGER_CYCLE%',
  'a manager cannot report to their own report (3-level loop)');
select throws_like($$select api.update_employee('20000000-0000-0000-0000-000000000003', 'Area Mgr Cairo', 'Area Manager',
                       null, null, null, null, null, '20000000-0000-0000-0000-000000000003')$$, 'MANAGER_CYCLE%',
  'nobody is their own manager');
select tests.clear_authentication();
select throws_like($$update core.employees set manager_id = '20000000-0000-0000-0000-000000000004'
                     where id = '20000000-0000-0000-0000-000000000001'$$, 'MANAGER_CYCLE%',
  'the trigger blocks a cycle on any write path');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is(api.update_employee('20000000-0000-0000-0000-000000000005', 'Rep Delta', 'Sales Representative',
            null, null, null, null, null, '20000000-0000-0000-0000-000000000003') -> 'changed', '["manager_id"]'::jsonb,
  'a legal move to another manager works');
select ok(exists (select 1 from audit.security_events where event_type = 'employee_reporting_changed'
                  and details ->> 'employee' = '20000000-0000-0000-0000-000000000005'),
  'a manager change is a security event (it moves team scope)');
select throws_like($$select api.update_employee('20000000-0000-0000-0000-000000000007', 'Admin', 'System Administrator',
                       null, null, null, null, null, '20000000-0000-0000-0000-000000000002')$$, 'SELF_GRANT_FORBIDDEN%',
  'an admin cannot change their own manager');
select throws_like($$select api.update_employee('20000000-0000-0000-0000-000000000001', 'Owner X', 'Company Owner')$$,
  'OWNER_ONLY%', 'an admin cannot edit the owner''s record');
select throws_like($$select api.update_employee('20000000-0000-0000-0000-000000000004', 'Rep Cairo', 'Sales Representative',
                       null, null, null, null, null, '20000000-0000-0000-0000-000000000003', null, '2000-01-01T00:00:00Z')$$,
  'CONFLICT%', 'a stale employee editor gets CONFLICT');

-- Holdings and status
select is((select count(*)::int from api.employee_customer_holdings('20000000-0000-0000-0000-000000000004')), 1,
  'the admin sees the one customer E004 holds (without CRM read access)');
select throws_like($$select api.set_employment_status('20000000-0000-0000-0000-000000000004', 'terminated', '  ')$$,
  'REASON_REQUIRED%', 'deactivation needs a reason');
select set_config('t.deact', api.set_employment_status('20000000-0000-0000-0000-000000000004', 'terminated', 'left the company')::text, true) is not null;
select is(current_setting('t.deact')::jsonb -> 'held_customers' -> 0 ->> 'customer_no', 'C-0001',
  'deactivation lists the customers still held');
select tests.clear_authentication();
select is((select count(*)::int from crm.customer_assignments where employee_id = '20000000-0000-0000-0000-000000000004'
            and valid_to is null), 1, 'and reassigns nothing');
select is((select terminated_on from core.employees where id = '20000000-0000-0000-0000-000000000004'), core.business_date(),
  'the termination date is today (Cairo)');
select ok(exists (select 1 from integration.outbox where event_type = 'employee.status_changed'
                  and aggregate_id = '20000000-0000-0000-0000-000000000004'), 'and employee.status_changed is emitted');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select throws_like($$select api.set_employment_status('20000000-0000-0000-0000-000000000004', 'terminated', 'again')$$,
  'INVALID_STATE%', 'terminating twice is refused');
select throws_like($$select api.set_employment_status('20000000-0000-0000-0000-000000000007', 'on_leave', 'holiday')$$,
  'SELF_SUSPEND_FORBIDDEN%', 'nobody changes their own status');
select throws_like($$select api.set_employment_status('20000000-0000-0000-0000-000000000001', 'suspended', 'coup')$$,
  'OWNER_ONLY%', 'an admin cannot suspend the owner''s employment');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((api.my_context() ->> 'active')::boolean, false, 'a terminated employee has no access at once');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is(api.set_employment_status('20000000-0000-0000-0000-000000000004', 'active', 'rehired') ->> 'status', 'active', 'reactivation works');
select is((select terminated_on from core.employees where id = '20000000-0000-0000-0000-000000000004'), null::date,
  'and clears the termination date');

-- Territory assignments
select is(api.assign_employee_territory('20000000-0000-0000-0000-000000000009',
            (select id from core.territories where code = 'CAI-GIZ'), 'member') ->> 'created', 'true', 'admin assigns a territory');
select is(api.assign_employee_territory('20000000-0000-0000-0000-000000000009',
            (select id from core.territories where code = 'CAI-GIZ'), 'manager') ->> 'created', 'false',
  'a second assignment to the same territory changes the type instead of duplicating');
select is((select assignment from api.v_employee_territories where employee_id = '20000000-0000-0000-0000-000000000009'
            and valid_to is null), 'manager', 'the view shows the new assignment type');
select throws_like($$select api.assign_employee_territory('20000000-0000-0000-0000-000000000007',
                       (select id from core.territories where code = 'DELTA'))$$, 'SELF_GRANT_FORBIDDEN%',
  'an admin cannot give themselves a territory');
select lives_ok($$select api.end_employee_territory((select id from core.employee_territories
                    where employee_id = '20000000-0000-0000-0000-000000000009' and valid_to is null))$$, 'and ends it');
select is((select count(*)::int from core.employee_territories where employee_id = '20000000-0000-0000-0000-000000000009'
            and valid_to is null), 0, 'no open assignment remains');

-- Scope and denials
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from api.v_admin_employees), 4, 'the area manager (team read) sees only their team (E003, E004, E005 moved in, E009)');
select throws_ok($$select api.update_employee('20000000-0000-0000-0000-000000000004', 'Rep Cairo', 'Rep')$$, '42501', null,
  'without core.employee.manage the area manager cannot edit even their own report');
select throws_ok($$select * from api.employee_customer_holdings('20000000-0000-0000-0000-000000000002')$$, '42501', null,
  'nor list what someone outside their team holds');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.set_employment_status('20000000-0000-0000-0000-000000000005', 'suspended', 'x')$$, '42501', null,
  'a rep cannot change an employment status');
select throws_ok($$select api.assign_employee_territory('20000000-0000-0000-0000-000000000004',
                     (select id from core.territories where code = 'DELTA'))$$, '42501', null,
  'nor assign territories');
select tests.clear_authentication();

-- Scoped management: the area manager role gets core.employee.manage at team scope and
-- core.territory.manage at territory scope (E003 manages CAI-GIZ and its sub-territories).
insert into authz.role_permissions (role_id, permission_code, scope)
select r.id, v.perm, v.scope from authz.roles r, (values ('core.employee.manage','team'), ('core.territory.manage','territory')) v(perm, scope)
where r.code = 'area_manager';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(api.update_employee('20000000-0000-0000-0000-000000000004', 'Rep Cairo', 'Senior Sales Representative',
            null, null, null, null, null, '20000000-0000-0000-0000-000000000003') -> 'changed', '["job_title"]'::jsonb,
  'team scope: the area manager edits a report');
select throws_ok($$select api.update_employee('20000000-0000-0000-0000-000000000006', 'Finance', 'Finance Officer')$$, '42501', null,
  'team scope: but not someone outside the team');
select throws_like($$select api.update_employee('20000000-0000-0000-0000-000000000004', 'Rep Cairo', 'Sales Representative',
                       null, null, null, null, null, '20000000-0000-0000-0000-000000000006')$$, 'PERMISSION_DENIED%',
  'team scope: nor move a report under a manager outside the team');
select tests.clear_authentication();

-- ===========================================================================
-- 4. Territories
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select set_config('t.area', api.create_territory('cai-east', 'Cairo East', 'شرق القاهرة',
                    (select id from core.territories where code = 'CAI-GIZ'))::text, true) is not null;
select is((select code || ' ' || level from core.territories where id = current_setting('t.area')::uuid), 'CAI-EAST area',
  'a new area under a region: code upper-cased, level follows the depth');
select set_config('t.sub', api.create_territory('CAI-EAST-1', 'Heliopolis', 'مصر الجديدة',
                    current_setting('t.area')::uuid)::text, true) is not null;
select throws_like($$select api.create_territory('CAI-EAST-1-A', 'Too deep', 'عميق جدا', current_setting('t.sub')::uuid)$$,
  'TERRITORY_TOO_DEEP%', 'a fourth level is refused');
select throws_like($$select api.create_territory('CAI-EAST', 'Dup', 'مكرر')$$, 'DUPLICATE%', 'codes are unique');

-- Move cycles: CAI-GIZ → CAI-EAST → CAI-EAST-1
select throws_like($$select api.move_territory((select id from core.territories where code = 'CAI-GIZ'), current_setting('t.sub')::uuid)$$,
  'TERRITORY_CYCLE%', 'a region cannot move under its own grandchild');
select throws_like($$select api.move_territory(current_setting('t.area')::uuid, current_setting('t.area')::uuid)$$,
  'TERRITORY_CYCLE%', 'nor under itself');
select tests.clear_authentication();
select throws_like($$update core.territories set parent_id = current_setting('t.sub')::uuid where code = 'CAI-GIZ'$$,
  'TERRITORY_CYCLE%', 'the trigger blocks a tree cycle on any write path');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select throws_like($$select api.move_territory(current_setting('t.area')::uuid, '10000000-0000-0000-0000-000000000003')$$,
  'TERRITORY_TOO_DEEP%', 'moving a two-level subtree under an area would make four levels');
select is(api.move_territory(current_setting('t.area')::uuid, (select id from core.territories where code = 'DELTA'), 'reorg') ->> 'level',
  'area', 'a subtree moves to another region');
select is((select level from core.territories where id = current_setting('t.sub')::uuid), 'sub_area', 'its child keeps a consistent level');
select is(api.move_territory(current_setting('t.area')::uuid, null) ->> 'level', 'region', 'and to the root (a region)');
select is((select level from core.territories where id = current_setting('t.sub')::uuid), 'area', 'its child becomes an area');
select ok(exists (select 1 from audit.security_events where event_type = 'territory_moved'), 'moves are security events');
select lives_ok($$select api.rename_territory(current_setting('t.area')::uuid, 'Cairo East (new)', 'شرق القاهرة الجديدة')$$, 'rename');

-- Deactivation
select throws_like($$select api.set_territory_active(current_setting('t.area')::uuid, false, 'merge')$$, 'TERRITORY_HAS_CHILDREN%',
  'a territory with active children cannot be deactivated');
select is((api.set_territory_active(current_setting('t.sub')::uuid, false, 'merged') ->> 'is_active'), 'false', 'a leaf can');
select throws_like($$select api.create_territory('CAI-EAST-2', 'X', 'س', current_setting('t.sub')::uuid)$$, 'INVALID_STATE%',
  'nothing new goes under an inactive territory');

-- Coverage and counts
select is(api.set_territory_coverage(current_setting('t.area')::uuid, 'EG-C', 'Heliopolis') ->> 'previous_territory_id', null,
  'a city is mapped to a territory');
select is(api.set_territory_coverage('10000000-0000-0000-0000-000000000003', 'EG-C', 'heliopolis') ->> 'previous_territory_id',
          current_setting('t.area'), 'mapping the same city (any case) again moves it and reports where it came from');
select is((select count(*)::int from api.v_territory_coverage where governorate_code = 'EG-C'), 1, 'one row per governorate + city');
select throws_like($$select api.set_territory_coverage(current_setting('t.sub')::uuid, 'EG-GZ')$$, 'INVALID_STATE%',
  'an inactive territory takes no coverage');
select lives_ok($$select api.remove_territory_coverage('EG-C', 'HELIOPOLIS')$$, 'coverage can be removed');
select is((select customers from api.territory_customer_counts() where territory_id = '10000000-0000-0000-0000-000000000003'), 1,
  'customer counts per territory (Nasr City has C-0001)');
select tests.clear_authentication();

-- Territory scope (area manager: CAI-GIZ, CAI-NASR; CAI-EAST moved out to the root above)
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select lives_ok($$select api.create_territory('CAI-WEST', 'Cairo West', 'غرب القاهرة', (select id from core.territories where code = 'CAI-GIZ'))$$,
  'territory scope: an area inside the managed region');
select throws_ok($$select api.create_territory('NEW-REGION', 'New region', 'إقليم جديد')$$, '42501', null,
  'territory scope: no new regions');
select throws_ok($$select api.move_territory('10000000-0000-0000-0000-000000000003', null)$$, '42501', null,
  'territory scope: no moving to the top level');
select throws_ok($$select api.set_territory_coverage((select id from core.territories where code = 'DELTA'), 'EG-DK')$$, '42501', null,
  'territory scope: no coverage for a territory outside it');
select ok((select count(*) = 3 and bool_and(territory_id is not null) from api.territory_customer_counts()),
  'territory scope: counts only for the three territories in scope, and no company-wide unassigned row');
select tests.clear_authentication();

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.create_territory('REP-T', 'Rep', 'مندوب')$$, '42501', null, 'a rep cannot create territories');
select throws_ok($$select api.move_territory('10000000-0000-0000-0000-000000000003', null)$$, '42501', null, 'nor move them');
select throws_ok($$select * from api.territory_customer_counts()$$, '42501', null, 'nor read the counts');
select tests.clear_authentication();

select * from finish();
rollback;
