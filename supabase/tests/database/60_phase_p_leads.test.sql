-- Phase P step 4 (leads around each rep): discovery runs queued on a base change, the claim/finish
-- service contract (Places content never stored, customers excluded by place id or within 50 m),
-- the cost guard (daily request cap, monthly budget), scope (rep / manager / other), rep commands,
-- the first visit (lead → CRM prospect), planning caps, reassignment and the daily housekeeping.
-- Synthetic data only; no Google request is made (the server's part is unit-tested with fetch mocked).
begin;
select tests.load_fixture();
select plan(114);

-- Fixture: E004 rep Cairo (a4, manager E003 = area mgr a3), E005 rep Delta (a5, manager E002 = sales
-- director a2), E009 new hire under E003 (no login). C-0001 (a4) is pinned at 30.044400, 31.235700.

-- ===========================================================================
-- Structure and privileges
-- ===========================================================================
select ok((select bool_and(relrowsecurity) from pg_class
           where oid in ('crm.leads'::regclass, 'crm.lead_discovery_runs'::regclass, 'crm.lead_api_usage'::regclass)),
  'the three lead tables have RLS enabled');
select ok(not has_table_privilege('authenticated', 'crm.leads', 'insert')
          and not has_table_privilege('authenticated', 'crm.leads', 'update')
          and not has_table_privilege('authenticated', 'crm.leads', 'delete')
          and not has_table_privilege('authenticated', 'crm.lead_discovery_runs', 'insert')
          and not has_table_privilege('authenticated', 'crm.lead_discovery_runs', 'update')
          and not has_table_privilege('authenticated', 'crm.lead_api_usage', 'insert'),
  'no direct writes on leads, runs or usage');
select ok((select bool_and(coalesce(c.reloptions @> array['security_invoker=true'], false)) from pg_class c
           where c.oid in ('api.v_leads'::regclass, 'api.v_lead_discovery_runs'::regclass, 'api.v_lead_stats'::regclass)),
  'the lead views are security_invoker');
select ok(not exists (select 1 from information_schema.columns
                      where table_schema = 'crm' and table_name in ('leads', 'lead_discovery_runs', 'lead_api_usage')
                        and (column_name ~ '(lat|lng|latitude|longitude|name|address|phone|rating|website)')),
  'Places policy: no coordinates, names, addresses or phones are stored for leads or runs');
select ok(has_function_privilege('authenticated', 'api.convert_lead(uuid, text, text, text, text, text, text, text, uuid)', 'execute')
          and has_function_privilege('authenticated', 'api.reassign_leads(uuid[], uuid, text)', 'execute')
          and has_function_privilege('authenticated', 'api.plan_lead_visit(uuid, date)', 'execute')
          and has_function_privilege('authenticated', 'api.lead_details_allowance(int)', 'execute')
          and not has_function_privilege('anon', 'api.convert_lead(uuid, text, text, text, text, text, text, text, uuid)', 'execute')
          and not has_function_privilege('anon', 'api.set_lead_status(uuid, text)', 'execute')
          and not has_function_privilege('anon', 'api.plan_visits(uuid, jsonb, uuid)', 'execute'),
  'the lead commands are for signed-in users only');
select ok(not has_function_privilege('authenticated', 'service.leads_claim_run(uuid, boolean)', 'execute')
          and not has_function_privilege('authenticated', 'service.leads_finish_run(uuid, text, int, int, boolean, text, jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'service.leads_daily()', 'execute')
          and has_function_privilege('service_role', 'service.leads_claim_run(uuid, boolean)', 'execute')
          and has_function_privilege('service_role', 'service.leads_finish_run(uuid, text, int, int, boolean, text, jsonb)', 'execute'),
  'the discovery job functions are for the service role only');
select ok(not has_function_privilege('authenticated', 'crm.lead_queue_run(uuid, text)', 'execute')
          and not has_function_privilege('authenticated', 'crm.lead_for_update(uuid, text)', 'execute')
          and not has_function_privilege('authenticated', 'crm.queue_lead_discovery_on_base()', 'execute')
          and not has_function_privilege('authenticated', 'field.planned_load(uuid, date, uuid)', 'execute'),
  'internal helpers and trigger functions are not client-callable');
select ok((select bool_and(owner_only) from core.setting_definitions where key in ('leads.daily_request_cap', 'leads.monthly_budget_usd'))
          and (select count(*) from core.setting_definitions where key in ('leads.daily_request_cap', 'leads.monthly_budget_usd')) = 2,
  'the cost guard settings are whitelisted and owner-only');
select is((select string_agg(value #>> '{}', ',' order by key) from core.system_settings
           where key in ('leads.daily_request_cap', 'leads.monthly_budget_usd')), '200,20',
  'defaults: 200 requests a day, 20 USD a month');
select is((select string_agg(r.code || ':' || rp.permission_code || ':' || rp.scope, ',' order by r.code, rp.permission_code)
           from authz.role_permissions rp join authz.roles r on r.id = rp.role_id
           where rp.permission_code like 'crm.lead.%'),
  'area_manager:crm.lead.assign:team,area_manager:crm.lead.read:team,area_manager:crm.lead.work:team,'
  'sales_director:crm.lead.assign:all,sales_director:crm.lead.read:all,sales_director:crm.lead.work:all,'
  'sales_rep:crm.lead.read:own,sales_rep:crm.lead.work:own',
  'lead permissions: reps own, area managers their team, the sales director everything');
select throws_like($$insert into crm.customers (customer_no, doctor_name, display_name, google_place_id)
                     values ('C-60X1', 'Dr. X', 'X', 'bad place id!')$$,
  '%customers_google_place_id_format%', 'a customer place id must look like a Google place id');

-- ===========================================================================
-- Queueing on a base change
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.set_employee_base_location('20000000-0000-0000-0000-000000000004', 'Synthetic base street 1', 30.050000, 31.240000,
                                         'manual') ->> 'changed', 'true', 'setup: the owner sets the Cairo rep''s base');
select tests.clear_authentication();
select ok((select status = 'queued' and trigger = 'base_location' and radius_km = 5.00
                  and requested_by = '00000000-0000-0000-0000-0000000000a1'
           from crm.lead_discovery_runs where employee_id = '20000000-0000-0000-0000-000000000004'),
  'saving a base queues a discovery run for the default 5 km');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.set_employee_base_location('20000000-0000-0000-0000-000000000004', 'Synthetic base street 1', 30.050000, 31.240000,
                                         'manual') ->> 'changed', 'false', 'saving the same base again');
select is(api.set_employee_base_location('20000000-0000-0000-0000-000000000004', 'Synthetic base street 1', 30.050000, 31.240000,
                                         'manual', 3) ->> 'lead_radius_km', '3.00', 'the owner changes the radius to 3 km');
select tests.clear_authentication();
select ok((select count(*) = 1 and min(radius_km) = 3.00 from crm.lead_discovery_runs
           where employee_id = '20000000-0000-0000-0000-000000000004'),
  'a radius change refreshes the one waiting run (no duplicate)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$select api.set_employee_base_location('20000000-0000-0000-0000-000000000005', 'Synthetic Delta base', 31.040000, 31.380000, 'manual')$$,
  'setup: the Delta rep''s base');
select lives_ok($$select api.set_employee_base_location('20000000-0000-0000-0000-000000000005', null, null, null)$$,
  'setup: the Delta base is removed again');
select tests.clear_authentication();
select is((select string_agg(status, ',') from crm.lead_discovery_runs where employee_id = '20000000-0000-0000-0000-000000000005'),
  'cancelled', 'removing the base cancels the waiting run');

-- "Run now" is the owner's.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select throws_like($$select api.request_lead_discovery('20000000-0000-0000-0000-000000000004')$$, 'OWNER_ONLY%',
  'the sales director cannot start discovery');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select throws_like($$select api.request_lead_discovery('20000000-0000-0000-0000-000000000005')$$, 'NO_BASE_LOCATION%',
  'discovery needs a base location');
select ok((select (r ->> 'run_id')::uuid = (select id from crm.lead_discovery_runs
                                             where employee_id = '20000000-0000-0000-0000-000000000004' and status = 'queued')
           from (select api.request_lead_discovery('20000000-0000-0000-0000-000000000004') r) x),
  'the owner''s request refreshes the same waiting run');
select tests.clear_authentication();
select is((select trigger from crm.lead_discovery_runs where employee_id = '20000000-0000-0000-0000-000000000004'), 'owner',
  'the waiting run now says who asked');

-- ===========================================================================
-- Claim: not configured, then a claimed run with its budget
-- ===========================================================================
set local role service_role;
select is(service.leads_claim_run(null, false) ->> 'status', 'not_configured', 'no server key: the run ends as not configured');
reset role;
select ok((select status = 'not_configured' and finished_at is not null and nearby_requests = 0
           from crm.lead_discovery_runs where employee_id = '20000000-0000-0000-0000-000000000004'),
  'the not-configured run made no request');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.run1', api.request_lead_discovery('20000000-0000-0000-0000-000000000004') ->> 'run_id', true) is not null;
select tests.clear_authentication();
set local role service_role;
select ok((select r ->> 'status' = 'claimed' and r ->> 'run_id' = current_setting('t.run1')
                  and (r #>> '{center,lat}')::numeric = 30.050000 and (r #>> '{center,lng}')::numeric = 31.240000
                  and (r ->> 'radius_m')::numeric = 3000 and (r ->> 'max_requests')::int = 200
           from (select service.leads_claim_run(current_setting('t.run1')::uuid, true) r) x),
  'a claim hands the server the base point, the radius and a budget within the daily cap (200)');
select is(service.leads_claim_run(null, true) ->> 'status', 'none', 'nothing else is waiting');
reset role;
select ok((select status = 'running' and reserved_requests = 200 and started_at is not null
           from crm.lead_discovery_runs where id = current_setting('t.run1')::uuid),
  'the run is running with its reserved budget');

-- ===========================================================================
-- Finish: de-duplication, exclusions, other rep, outside radius
-- ===========================================================================
-- A place already a customer (by place id), and an existing lead of the Delta rep.
update crm.customers set google_place_id = 'ChIJsynthCustomer0002' where id = '40000000-0000-0000-0000-000000000002';
insert into crm.leads (place_id, employee_id) values ('ChIJsynthDeltaLead001', '20000000-0000-0000-0000-000000000005');

set local role service_role;
select ok((select r ->> 'places_found' = '6' and r ->> 'leads_new' = '2' and r ->> 'excluded_customers' = '2'
                  and r ->> 'other_rep' = '1' and r ->> 'outside_radius' = '1' and (r ->> 'estimated_cost_usd')::numeric = 1.4400
           from (select service.leads_finish_run(current_setting('t.run1')::uuid, 'done', 40, 5, false, null, jsonb_build_array(
             jsonb_build_object('place_id', 'ChIJsynthLeadPlace001', 'distance_m', 812.44, 'lat', 30.0560, 'lng', 31.2440),
             jsonb_build_object('place_id', 'ChIJsynthLeadPlace001', 'distance_m', 812.44, 'lat', 30.0560, 'lng', 31.2440),
             jsonb_build_object('place_id', 'ChIJsynthLeadPlace002', 'distance_m', 1500, 'lat', 30.0460, 'lng', 31.2380),
             jsonb_build_object('place_id', 'ChIJsynthCustomer0002', 'distance_m', 900, 'lat', 30.0550, 'lng', 31.2420),
             jsonb_build_object('place_id', 'ChIJsynthNear50m00001', 'distance_m', 790, 'lat', 30.044650, 'lng', 31.235700),
             jsonb_build_object('place_id', 'ChIJsynthDeltaLead001', 'distance_m', 300, 'lat', 30.0510, 'lng', 31.2410),
             jsonb_build_object('place_id', 'ChIJsynthFarAway00001', 'distance_m', 3200.5, 'lat', 30.0700, 'lng', 31.2600),
             jsonb_build_object('place_id', 'not a place id', 'distance_m', 10))) r) x),
  'finish: 6 distinct valid places → 2 new leads, 2 customers excluded, 1 of another rep, 1 outside the radius; cost 45 × 0.032');
reset role;
select set_config('t.l1', (select id::text from crm.leads where place_id = 'ChIJsynthLeadPlace001'), true) is not null;
select set_config('t.l2', (select id::text from crm.leads where place_id = 'ChIJsynthLeadPlace002'), true) is not null;
select is((select string_agg(place_id || ':' || distance_m, ',' order by place_id) from crm.leads
           where employee_id = '20000000-0000-0000-0000-000000000004'),
  'ChIJsynthLeadPlace001:812.4,ChIJsynthLeadPlace002:1500.0', 'the new leads keep only the place id and our distance');
select ok(not exists (select 1 from crm.leads where place_id = 'ChIJsynthNear50m00001'),
  'a place 28 m from a pinned customer is not a lead (50 m rule, coordinates used in the call only)');
select ok(not exists (select 1 from crm.leads where place_id = 'ChIJsynthCustomer0002'),
  'a place already linked to a customer is not a lead');
select is((select employee_id from crm.leads where place_id = 'ChIJsynthDeltaLead001'), '20000000-0000-0000-0000-000000000005'::uuid,
  'another rep''s lead is not taken over by a run');
select ok((select status = 'done' and nearby_requests = 40 and text_requests = 5 and estimated_cost_usd = 1.4400
                  and leads_new = 2 and finished_at is not null
           from crm.lead_discovery_runs where id = current_setting('t.run1')::uuid),
  'the run records its requests, estimated cost and counts');
select ok(not exists (select 1 from integration.outbox where event_type = 'crm.lead_discovery_finished'
                      and payload::text ~ '(30\.05|31\.24|lat|lng)'),
  'the outbox event carries counts, no coordinates');
select is((select count(*)::int from notify.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000a4'
           and type = 'leads.discovered'), 1, 'the rep is told about the new clinics');
set local role service_role;
select throws_like($$select service.leads_finish_run(current_setting('t.run1')::uuid, 'done', 1, 0)$$, 'INVALID_STATE%',
  'a finished run cannot be finished twice');
reset role;

-- ===========================================================================
-- Scope: rep, manager, other
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select string_agg(place_id, ',' order by distance_m) from api.v_leads),
  'ChIJsynthLeadPlace001,ChIJsynthLeadPlace002', 'rep: their own leads, nearest first');
select ok((select bool_and(in_latest_run and status = 'new' and employee_name_en = 'Rep Cairo') from api.v_leads),
  'rep: status new, seen in the latest run, with the rep''s name');
select is((select count(*)::int from api.v_lead_discovery_runs), 2, 'rep: their own runs (the not-configured and the done one)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select string_agg(place_id, ',') from api.v_leads), 'ChIJsynthDeltaLead001', 'the Delta rep sees only their own lead');
select is((select count(*)::int from api.v_lead_discovery_runs), 1, 'and only their own (cancelled) run');
select throws_like(format('select api.set_lead_status(%L, %L)', current_setting('t.l1'), 'visited'),
  'NOT_FOUND%', 'another rep cannot touch the Cairo rep''s lead (no existence oracle)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select string_agg(place_id, ',' order by place_id) from api.v_leads),
  'ChIJsynthLeadPlace001,ChIJsynthLeadPlace002', 'area manager: their team''s leads only');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from api.v_leads), 3, 'sales director: every lead');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select count(*)::int from api.v_leads), 0, 'finance (no crm.lead.read): no lead');
select throws_like($$select api.lead_details_allowance(5)$$, 'PERMISSION_DENIED%', 'and no live details either');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from api.v_leads), 3, 'owner: every lead');
select ok((select (u ->> 'today_requests')::int = 45 and (u ->> 'month_run_cost_usd')::numeric = 1.44
                  and (u ->> 'daily_request_cap')::numeric = 200 and (u ->> 'monthly_budget_usd')::numeric = 20
           from (select api.lead_usage() u) x),
  'owner: usage today and this month against the caps');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select throws_like($$select api.lead_usage()$$, 'OWNER_ONLY%', 'the budget view is the owner''s');

-- ===========================================================================
-- Rep commands: status, notes, planning
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.set_lead_status(current_setting('t.l2')::uuid, 'visited') ->> 'status', 'visited', 'rep: new → visited');
select is(api.set_lead_status(current_setting('t.l2')::uuid, 'visited') ->> 'replayed', 'true', 'the same status again is a replay');
select throws_like(format('select api.set_lead_status(%L, %L)', current_setting('t.l2'), 'prospect'), 'VALIDATION%',
  'prospect only comes from the first visit');
select is(api.set_lead_status(current_setting('t.l2')::uuid, 'not_interested') ->> 'status', 'not_interested', 'rep: → not interested');
select is(api.set_lead_status(current_setting('t.l2')::uuid, 'new') ->> 'status', 'new', 'rep: a not-interested lead can be reopened');
select is(api.set_lead_notes(current_setting('t.l1')::uuid, '  Doctor is in after 6 pm  ') ->> 'changed', 'true', 'rep: own notes');
select is((select notes from api.v_leads where id = current_setting('t.l1')::uuid), 'Doctor is in after 6 pm', 'notes are trimmed');
select throws_like(format('select api.set_lead_notes(%L, %L)', current_setting('t.l1'), repeat('x', 2001)), 'VALIDATION%',
  'notes are at most 2000 characters');

select is(api.plan_lead_visit(current_setting('t.l1')::uuid, core.business_date()) ->> 'planned_for', core.business_date()::text,
  'rep: add a lead to today''s plan');
select is(api.plan_lead_visit(current_setting('t.l1')::uuid, core.business_date()) ->> 'replayed', 'true', 'planning it again is a replay');
select ok((select planned_today from api.v_leads where id = current_setting('t.l1')::uuid), 'the list shows it as planned today');
select throws_like(format('select api.plan_lead_visit(%L, %L::date)', current_setting('t.l1'), core.business_date() - 1), 'PAST_DATE%',
  'a lead cannot be planned in the past');
select tests.clear_authentication();
update core.system_settings set value = '1' where key = 'planning.daily_visit_cap';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like(format('select api.plan_lead_visit(%L, %L::date)', current_setting('t.l2'), core.business_date()), 'DAILY_CAP%',
  'planning.daily_visit_cap counts planned leads');
select throws_like(format($$select api.plan_visits(null, '[{"customer_id":"40000000-0000-0000-0000-000000000001","date":"%s"}]'::jsonb,
                                                    '60000000-0000-0000-0000-0000000000c1')$$, core.business_date()),
  'DAILY_CAP%', 'api.plan_visits counts planned leads against the same cap');
select is(api.plan_visits(null, format('[{"customer_id":"40000000-0000-0000-0000-000000000001","date":"%s"}]', core.business_date() + 1)::jsonb,
                          '60000000-0000-0000-0000-0000000000c2') ->> 'created', '1', 'api.plan_visits still plans a free day');
select throws_like(format('select api.plan_lead_visit(%L, %L::date)', current_setting('t.l2'), core.business_date() + 1), 'DAILY_CAP%',
  'and a lead does not fit on a day already full of customer visits');
select tests.clear_authentication();
update core.system_settings set value = '8' where key = 'planning.daily_visit_cap';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.plan_lead_visit(current_setting('t.l2')::uuid, core.business_date()) ->> 'replayed', 'false', 'with room, a second lead fits today');
select is(api.unplan_lead_visit(current_setting('t.l2')::uuid) ->> 'replayed', 'false', 'rep: remove a lead from the plan');
select ok((select planned_for is null from api.v_leads where id = current_setting('t.l2')::uuid), 'the plan is cleared');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(api.set_lead_status(current_setting('t.l2')::uuid, 'visited') ->> 'status', 'visited',
  'area manager: works a team lead (team scope)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.set_lead_status(current_setting('t.l2')::uuid, 'new') ->> 'status', 'new', 'setup: back to new');

-- Live details allowance (monthly budget).
select is(api.lead_details_allowance(20), 20, 'rep: 20 live details fit the budget');
select tests.clear_authentication();
select ok((select detail_requests = 20 and estimated_cost_usd = 0.3400 from crm.lead_api_usage
           where user_id = '00000000-0000-0000-0000-0000000000a4'), 'the granted details are counted (20 × 0.017)');
update core.system_settings set value = '1.78' where key = 'leads.monthly_budget_usd';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.lead_details_allowance(10), 0, 'budget reached (1.44 runs + 0.34 details): no more live details');
select throws_like($$select api.lead_details_allowance(51)$$, 'VALIDATION%', 'at most 50 details per call');
select tests.clear_authentication();
update core.system_settings set value = '20' where key = 'leads.monthly_budget_usd';

-- ===========================================================================
-- First visit → prospect
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select throws_like(format('select api.convert_lead(%L, %L, %L)', current_setting('t.l1'), 'Dr. Synthetic Lead', 'Synthetic Lead Clinic'),
  'NOT_FOUND%', 'another rep cannot convert the lead');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like(format('select api.convert_lead(%L)', current_setting('t.l1')), 'VALIDATION%',
  'the first visit needs the doctor or clinic name (create_customer rules)');
select set_config('t.conv', api.convert_lead(current_setting('t.l1')::uuid, 'Dr. Synthetic Lead', 'Synthetic Lead Clinic', null, null,
                                             'EG-C', 'Nasr City', 'Met the doctor', '60000000-0000-0000-0000-0000000000d1')::text, true) is not null;
select ok((select (current_setting('t.conv')::jsonb) ->> 'replayed' = 'false'
                  and (current_setting('t.conv')::jsonb) -> 'warnings' @> '[{"code":"PHONE_MISSING"}]'),
  'the rep converts the lead (no phone: allowed, flagged)');
select set_config('t.cust', (current_setting('t.conv')::jsonb) ->> 'customer_id', true) is not null;
select ok((select lifecycle_stage = 'prospect' and google_place_id = 'ChIJsynthLeadPlace001' and phone_primary is null
                  and notes = 'Met the doctor' and source = 'field' and latitude is null
           from crm.customers where id = current_setting('t.cust')::uuid),
  'a CRM customer at stage prospect, linked to the place id, with HONEST''s own data');
select is((select employee_id from crm.customer_assignments where customer_id = current_setting('t.cust')::uuid and valid_to is null),
  '20000000-0000-0000-0000-000000000004'::uuid, 'owned by the lead''s rep');
select ok((select status = 'prospect' and customer_id = current_setting('t.cust')::uuid and planned_for is null
                  and customer_stage = 'prospect'
           from api.v_leads where id = current_setting('t.l1')::uuid),
  'the lead is a prospect, linked to the customer, and off the plan');
select is(api.convert_lead(current_setting('t.l1')::uuid, 'Dr. Synthetic Lead', 'Synthetic Lead Clinic') ->> 'replayed', 'true',
  'converting again answers the same customer');
select throws_like(format('select api.set_lead_status(%L, %L)', current_setting('t.l1'), 'new'), 'INVALID_STATE%',
  'a converted lead''s status follows the CRM');
select is(api.visit_check_in('60000000-0000-0000-0000-0000000000e1', current_setting('t.cust')::uuid,
                             30.056010, 31.244020, 15, now() - interval '5 minutes') ->> 'verification_status',
  'no_customer_location', 'the rep checks in at the new prospect');
select is((select status from api.v_customer_location_proposals where customer_id = current_setting('t.cust')::uuid), 'pending',
  'the check-in fix is proposed as the clinic pin (step-3 flow)');
select tests.clear_authentication();
select is((select count(*)::int from crm.activities where customer_id = current_setting('t.cust')::uuid
           and summary like 'Stage changed: lead → prospect%'), 1, 'the timeline shows the stage change');
select is((select count(*)::int from integration.outbox where event_type = 'crm.lead_converted'), 1, 'the conversion is published');
update crm.customers set lifecycle_stage = 'active' where id = current_setting('t.cust')::uuid;
select is((select status from crm.leads where id = current_setting('t.l1')::uuid), 'customer',
  'when the prospect becomes an active customer, the lead says customer');

-- A later run finds the converted clinic again: excluded by its place id.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.run2', api.request_lead_discovery('20000000-0000-0000-0000-000000000004') ->> 'run_id', true) is not null;
select tests.clear_authentication();
set local role service_role;
select is((service.leads_claim_run(current_setting('t.run2')::uuid, true) ->> 'max_requests')::int, 155,
  'the next run''s budget is what is left of the daily cap (200 − 45)');
select ok((select r ->> 'excluded_customers' = '1' and r ->> 'leads_seen' = '1' and r ->> 'leads_new' = '0'
           from (select service.leads_finish_run(current_setting('t.run2')::uuid, 'done', 10, 0, false, null, jsonb_build_array(
             jsonb_build_object('place_id', 'ChIJsynthLeadPlace001', 'distance_m', 812, 'lat', 30.0560, 'lng', 31.2440),
             jsonb_build_object('place_id', 'ChIJsynthLeadPlace002', 'distance_m', 1490))) r) x),
  'a converted clinic is excluded; a known lead is seen again');
reset role;
select is((select distance_m from crm.leads where id = current_setting('t.l2')::uuid), 1490.0, 'the distance is refreshed');

-- ===========================================================================
-- Cost guard
-- ===========================================================================
update core.system_settings set value = '55' where key = 'leads.daily_request_cap';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.run3', api.request_lead_discovery('20000000-0000-0000-0000-000000000004') ->> 'run_id', true) is not null;
select tests.clear_authentication();
set local role service_role;
select ok((select r ->> 'status' = 'refused' and r ->> 'reason' = 'daily_cap'
           from (select service.leads_claim_run(null, true) r) x),
  'over the daily cap (55 used of 55): the run is refused');
reset role;
select ok((select status = 'queued' and refusal = 'daily_cap' and refused_at is not null
           from crm.lead_discovery_runs where id = current_setting('t.run3')::uuid),
  'the refused run waits, with the reason');
update core.system_settings set value = '200' where key = 'leads.daily_request_cap';
update core.system_settings set value = '2' where key = 'leads.monthly_budget_usd';
set local role service_role;
select ok((select r ->> 'status' = 'refused' and r ->> 'reason' = 'monthly_budget'
           from (select service.leads_claim_run(null, true) r) x),
  'over the monthly budget (1.76 runs + 0.34 details of 2.00): refused');
reset role;
update core.system_settings set value = '2.5' where key = 'leads.monthly_budget_usd';
set local role service_role;
select is((service.leads_claim_run(null, true) ->> 'max_requests')::int, 12,
  'with 0.40 USD left the run gets 12 requests (0.40 / 0.032)');
reset role;
select ok((select refusal is null and status = 'running' from crm.lead_discovery_runs where id = current_setting('t.run3')::uuid),
  'a claimed run clears its refusal');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select throws_like($$select api.update_setting('leads.daily_request_cap', '500'::jsonb)$$, 'OWNER_ONLY%',
  'the IT admin cannot raise the cap');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.update_setting('leads.daily_request_cap', '300'::jsonb) ->> 'changed', 'true', 'the owner can');
select tests.clear_authentication();
-- A run left running is failed at the next claim and charged its reserved budget.
update crm.lead_discovery_runs set started_at = now() - interval '20 minutes' where id = current_setting('t.run3')::uuid;
set local role service_role;
select is(service.leads_claim_run(null, true) ->> 'status', 'none', 'next claim: nothing waiting');
reset role;
select ok((select status = 'failed' and error_code = 'stale' and nearby_requests = 12 from crm.lead_discovery_runs
           where id = current_setting('t.run3')::uuid), 'a stale running run is failed and charged its reserved requests');

-- ===========================================================================
-- Reassignment
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like(format('select api.reassign_leads(array[%L]::uuid[], %L, %L)', current_setting('t.l2'),
                          '20000000-0000-0000-0000-000000000009', 'moving'), 'PERMISSION_DENIED%',
  'a rep cannot reassign leads');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_like(format('select api.reassign_leads(array[%L]::uuid[], %L, %L)', current_setting('t.l2'),
                          '20000000-0000-0000-0000-000000000009', ' '), 'REASON_REQUIRED%', 'a reason is required');
select throws_like(format('select api.reassign_leads(array[%L]::uuid[], %L, %L)', current_setting('t.l2'),
                          '20000000-0000-0000-0000-000000000005', 'moving'), 'PERMISSION_DENIED%',
  'area manager: not to a rep outside the team');
select throws_like($$select api.reassign_leads(array[(select id from crm.leads where place_id = 'ChIJsynthDeltaLead001')]::uuid[],
                                               '20000000-0000-0000-0000-000000000009', 'moving')$$, 'NOT_FOUND%',
  'area manager: not a lead outside the team');
select throws_like(format('select api.reassign_leads(array[%L]::uuid[], %L, %L)', current_setting('t.l1'),
                          '20000000-0000-0000-0000-000000000009', 'moving'), 'INVALID_STATE%',
  'a converted lead moves with its customer, not here');
select is(api.reassign_leads(array[current_setting('t.l2')::uuid], '20000000-0000-0000-0000-000000000009', 'territory split') ->> 'moved', '1',
  'area manager: moves a team lead to another team member');
select ok((select employee_id = '20000000-0000-0000-0000-000000000009' and distance_m is null and assigned_by = '00000000-0000-0000-0000-0000000000a3'
           from crm.leads where id = current_setting('t.l2')::uuid),
  'the lead belongs to the new rep (the old base distance is cleared)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(api.reassign_leads(array[(select id from crm.leads where place_id = 'ChIJsynthDeltaLead001')]::uuid[],
                             '20000000-0000-0000-0000-000000000004', 'cover Delta') ->> 'moved', '1',
  'sales director (all): moves the Delta lead to the Cairo rep');
select tests.clear_authentication();
select is((select count(*)::int from notify.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000a4'
           and type = 'leads.assigned'), 1, 'the receiving rep is notified');

-- ===========================================================================
-- Manager view
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select ok((select total = 2 and customer_count = 1 and new_count = 1 and visited_pct = 50.0 and converted_pct = 50.0
                  and last_run_status is not null
           from api.v_lead_stats where employee_id = '20000000-0000-0000-0000-000000000004'),
  'area manager: per rep leads, visited % and converted %, with the last run');
select is((select string_agg(employee_name_en, ',' order by employee_name_en) from api.v_lead_stats), 'New Hire,Rep Cairo',
  'area manager: only their team in the stats');

-- ===========================================================================
-- Daily housekeeping: 30-day distance limit, monthly refresh
-- ===========================================================================
select tests.clear_authentication();
update crm.leads set distance_computed_at = now() - interval '31 days' where distance_m is not null;
update crm.lead_discovery_runs set finished_at = now() - interval '29 days' where employee_id = '20000000-0000-0000-0000-000000000004';
set local role service_role;
select ok((select (r ->> 'distances_cleared')::int >= 1 and (r ->> 'refresh_queued')::int = 1
           from (select service.leads_daily() r) x),
  'daily job: distances older than 30 days are cleared, a refresh run is queued');
reset role;
select is((select count(*)::int from crm.leads where distance_m is not null), 0, 'no distance older than 30 days remains');
select is((select trigger from crm.lead_discovery_runs where employee_id = '20000000-0000-0000-0000-000000000004' and status = 'queued'),
  'refresh', 'the refresh run waits for the next claim');

select * from finish();
rollback;
