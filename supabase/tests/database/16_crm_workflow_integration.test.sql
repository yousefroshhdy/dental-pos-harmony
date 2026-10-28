-- End-to-end: CRM/field approval requests (migration 0200) decided by the
-- generic approval engine (migration 0300), with scope-limited approvers.
begin;
select tests.load_fixture();
select plan(11);

-- ---- Visit exception: rep a4 (Cairo) → area manager a3 (team scope) approves ----
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select api.visit_check_in('80000000-0000-0000-0000-0000000000e1', '40000000-0000-0000-0000-000000000001',
                          30.064400, 31.235700, 20, now(), '{}');            -- ~2.2 km away → out_of_range
select is((select api.request_visit_exception('80000000-0000-0000-0000-0000000000e1', 'clinic moved next door')
           ->> 'verification_status'), 'exception_requested', 'rep requests a visit exception');

select tests.clear_authentication();
-- Look request ids up as admin (callers may not see them under RLS), then pass them in.
select set_config('t.visit_req', (select r.id::text from wf.approval_requests r join wf.workflow_definitions d on d.id = r.definition_id
  where d.code = 'field.visit.exception' and r.entity_id = '80000000-0000-0000-0000-0000000000e1'), false);
select is((select subject_employee_id from wf.approval_requests r join wf.workflow_definitions d on d.id = r.definition_id
           where d.code = 'field.visit.exception' and r.entity_id = '80000000-0000-0000-0000-0000000000e1'),
          '20000000-0000-0000-0000-000000000004'::uuid, 'visit exception request names the rep as subject');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');      -- Delta rep: not an approver
select throws_like($$select api.decide_approval(current_setting('t.visit_req')::uuid, 'approve')$$,
  '%PERMISSION_DENIED%', 'an unrelated rep cannot decide the exception');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');      -- the rep's area manager
select is((select api.decide_approval(current_setting('t.visit_req')::uuid, 'approve', 'ok')
           ->> 'status'), 'approved', 'the rep''s area manager (team scope) approves');
select tests.clear_authentication();
select is((select verification_status from field.visits where id = '80000000-0000-0000-0000-0000000000e1'),
          'exception_approved', 'engine ran the field hook: visit exception approved');

-- ---- Customer reassignment: C-0001 (Nasr City) from rep a4 to new hire E009 ----
update core.employees set employment_status = 'active' where id = '20000000-0000-0000-0000-000000000009';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select ok((select api.request_customer_reassignment('40000000-0000-0000-0000-000000000001',
            '20000000-0000-0000-0000-000000000009', 'territory rebalancing') ->> 'approval_request_id') is not null,
  'rep requests a reassignment of own customer');
select tests.clear_authentication();
select set_config('t.reassign_req', (select r.id::text from wf.approval_requests r join wf.workflow_definitions d on d.id = r.definition_id
  where d.code = 'crm.customer.reassign' and r.status = 'pending'), false);
select is((select (payload ->> 'territory_id')::uuid from wf.approval_requests r join wf.workflow_definitions d on d.id = r.definition_id
           where d.code = 'crm.customer.reassign' and r.status = 'pending'),
          '10000000-0000-0000-0000-000000000003'::uuid, 'reassignment request carries the customer territory');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.decide_approval(current_setting('t.reassign_req')::uuid, 'approve')$$,
  '%SELF_APPROVAL%', 'the requester cannot approve their own reassignment');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');      -- territory-scoped approver for Cairo
select is((select api.decide_approval(current_setting('t.reassign_req')::uuid, 'approve', 'agreed') ->> 'status'),
          'approved', 'Cairo area manager (territory scope) approves');
select tests.clear_authentication();
select is((select employee_id from crm.customer_assignments where customer_id = '40000000-0000-0000-0000-000000000001'
           and role = 'primary_rep' and valid_to is null), '20000000-0000-0000-0000-000000000009'::uuid,
          'engine ran the CRM hook: customer now assigned to the new rep');
select is((select count(*)::int from crm.customer_assignments where customer_id = '40000000-0000-0000-0000-000000000001'
           and role = 'primary_rep' and valid_to is null), 1, 'exactly one open primary assignment remains');

select * from finish();
rollback;
