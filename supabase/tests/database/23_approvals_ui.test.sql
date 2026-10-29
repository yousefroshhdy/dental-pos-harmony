-- Approvals UI read surface (migration 20261030000500): api.v_approval_requests verdicts and
-- display context, api.v_approval_steps, visibility after deciding, notifications round trip.
begin;
select tests.load_fixture();
select plan(40);

-- ---------------------------------------------------------------------------
-- Privilege surface
-- ---------------------------------------------------------------------------
select ok(has_table_privilege('authenticated', 'api.v_approval_requests', 'select')
          and has_table_privilege('authenticated', 'api.v_approval_steps', 'select'),
  'authenticated can read the approval views');
select ok(not has_table_privilege('anon', 'api.v_approval_requests', 'select')
          and not has_table_privilege('anon', 'api.v_approval_steps', 'select'),
  'anon cannot read the approval views');
select ok(not has_function_privilege('anon', 'authz.approval_verdict(uuid)', 'execute')
          and not has_function_privilege('anon', 'authz.approval_decided_ids()', 'execute')
          and not has_function_privilege('anon', 'core.user_display(uuid)', 'execute'),
  'anon cannot execute the approval helpers');

-- ---------------------------------------------------------------------------
-- Setup (as superuser): a second stage on inventory adjustments, and a finance approver
-- whose adjustment limit (3 units) is below the request.
-- ---------------------------------------------------------------------------
insert into wf.workflow_stages (rule_id, stage_no, approver_type, approver_permission)
select ws.rule_id, 2, 'permission', 'wf.decide.inventory_adjustment'
from wf.workflow_stages ws join wf.workflow_rules wr on wr.id = ws.rule_id
join wf.workflow_definitions d on d.id = wr.definition_id
where d.code = 'inventory.adjustment' and ws.stage_no = 1;
insert into authz.roles (id, code, name_en) values ('70000000-0000-0000-0000-0000000000f1', 'tst_adj_approver', 'Test adjustment approver');
insert into authz.role_permissions (role_id, permission_code, scope, limit_value) values
  ('70000000-0000-0000-0000-0000000000f1', 'wf.decide.inventory_adjustment', 'all', 3);
insert into authz.user_roles (user_id, role_id) values ('00000000-0000-0000-0000-0000000000a6', '70000000-0000-0000-0000-0000000000f1');

-- ---------------------------------------------------------------------------
-- Inventory adjustment above the requester's limit (a8 limit 5, requests +10)
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(api.request_inventory_adjustment('60000000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000001', 10, 'count correction', 'ui23-adj-1') ->> 'status', 'pending_approval',
  'inventory manager requests an adjustment above the limit');
select tests.clear_authentication();
select set_config('t.adj', (select r.id::text from wf.approval_requests r join wf.workflow_definitions d on d.id = r.definition_id
  where d.code = 'inventory.adjustment' and r.payload ->> 'idempotency_key' = 'ui23-adj-1'), false);

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is((select my_verdict from api.v_approval_requests where request_id = current_setting('t.adj')::uuid), 'own_request',
  'requester: verdict own_request');
select ok((select is_mine and not can_decide from api.v_approval_requests where request_id = current_setting('t.adj')::uuid),
  'requester: is_mine, cannot decide');
select is((select requester_name_en from api.v_approval_requests where request_id = current_setting('t.adj')::uuid), 'Inventory',
  'requester name resolves');
select is((select warehouse_code || '/' || variant_sku from api.v_approval_requests where request_id = current_setting('t.adj')::uuid),
  'WH-CAI/BIO-TOP-4110', 'warehouse and SKU context resolve for an inventory reader');
select is((select stage_count from api.v_approval_requests where request_id = current_setting('t.adj')::uuid), 2,
  'stage count visible to a wf.approval.read holder');
select throws_like($$select api.decide_approval(current_setting('t.adj')::uuid, 'approve')$$, 'SELF_APPROVAL%',
  'requester cannot decide (matches the verdict)');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');      -- limit 3 < 10
select is((select my_verdict from api.v_approval_requests where request_id = current_setting('t.adj')::uuid), 'limit',
  'approver under the limit: verdict limit');
select is((select can_decide from api.v_approval_requests where request_id = current_setting('t.adj')::uuid), false,
  'approver under the limit cannot decide');
select throws_like($$select api.decide_approval(current_setting('t.adj')::uuid, 'approve')$$, 'LIMIT_EXCEEDED%',
  'decide_approval agrees: LIMIT_EXCEEDED');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');      -- reads all, holds no adjustment decision
select is((select my_verdict from api.v_approval_requests where request_id = current_setting('t.adj')::uuid), 'not_approver',
  'reader without the decide permission: verdict not_approver');
select throws_like($$select api.decide_approval(current_setting('t.adj')::uuid, 'approve')$$, 'PERMISSION_DENIED%',
  'decide_approval agrees: PERMISSION_DENIED');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');      -- unrelated rep
select is((select count(*)::int from api.v_approval_requests where request_id = current_setting('t.adj')::uuid), 0,
  'unrelated rep does not see the request');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');      -- owner
select ok((select my_verdict = 'ok' and can_decide and current_stage = 1 and stage_permission = 'wf.decide.inventory_adjustment'
           from api.v_approval_requests where request_id = current_setting('t.adj')::uuid),
  'owner: verdict ok at stage 1 with the stage permission');
select is((select api.decide_approval(current_setting('t.adj')::uuid, 'approve', 'counted twice') ->> 'current_stage'), '2',
  'owner approves stage 1; the request moves to stage 2');
select is((select my_verdict from api.v_approval_requests where request_id = current_setting('t.adj')::uuid), 'already_decided',
  'owner at stage 2: verdict already_decided (distinct approvers)');
select ok((select decided_by_me and my_decision = 'approved' and status = 'pending'
           from api.v_approval_requests where request_id = current_setting('t.adj')::uuid),
  'owner: decided_by_me with the decision, request still pending');
select throws_like($$select api.decide_approval(current_setting('t.adj')::uuid, 'approve')$$, 'ALREADY_DECIDED%',
  'decide_approval agrees: ALREADY_DECIDED');
select is((select stage_approvals from api.v_approval_requests where request_id = current_setting('t.adj')::uuid), 0,
  'no approvals counted yet at stage 2');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is((select count(*)::int from api.v_approval_steps where request_id = current_setting('t.adj')::uuid), 1,
  'requester sees the decision trail');
select ok((select approver_name_en = 'Owner' and decision = 'approved' and comment = 'counted twice' and on_behalf_of is null
           from api.v_approval_steps where request_id = current_setting('t.adj')::uuid),
  'step shows approver name, decision and comment');

-- ---------------------------------------------------------------------------
-- Customer reassignment decided by a delegate (a3 → a5), who has no wf.approval.read
-- ---------------------------------------------------------------------------
select tests.clear_authentication();
update core.employees set employment_status = 'active' where id = '20000000-0000-0000-0000-000000000009';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select ok((select api.request_customer_reassignment('40000000-0000-0000-0000-000000000001',
            '20000000-0000-0000-0000-000000000009', 'territory rebalancing') ->> 'approval_request_id') is not null,
  'rep requests a reassignment of own customer');
select tests.clear_authentication();
select set_config('t.re', (select r.id::text from wf.approval_requests r join wf.workflow_definitions d on d.id = r.definition_id
  where d.code = 'crm.customer.reassign' and r.status = 'pending'), false);

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select ok((select customer_name = 'Dr. Ahmed Clinic' and customer_no = 'C-0001' and from_employee_name_en = 'Rep Cairo'
                  and subject_name_en = 'Rep Cairo' and my_verdict = 'own_request'
           from api.v_approval_requests where request_id = current_setting('t.re')::uuid),
  'requester sees customer and employee context');
select is((select stage_count from api.v_approval_requests where request_id = current_setting('t.re')::uuid), null::int,
  'stage configuration stays hidden without wf.approval.read');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from api.v_approval_requests), 0, 'Delta rep sees no requests before the delegation');

select tests.clear_authentication();
insert into wf.delegations (from_user_id, to_user_id, definition_id, valid_from, valid_to) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a5', null, now() - interval '1 hour', now() + interval '1 day');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select my_verdict from api.v_approval_requests where request_id = current_setting('t.re')::uuid), 'ok',
  'delegate: verdict ok');
select is((select count(*)::int from api.v_approval_requests), 1, 'delegate sees only the request they can decide');
select is((select api.decide_approval(current_setting('t.re')::uuid, 'approve', 'agreed') ->> 'status'), 'approved',
  'delegate approves on behalf of the area manager');
select ok((select decided_by_me and my_decision = 'approved' and my_verdict = 'closed' and status = 'approved'
           from api.v_approval_requests where request_id = current_setting('t.re')::uuid),
  'delegate still sees the request after deciding (decided-by-me history)');
select ok((select approver_name_en = 'Rep Delta' and on_behalf_of_name_en = 'Area Mgr Cairo'
           from api.v_approval_steps where request_id = current_setting('t.re')::uuid),
  'step names the delegate and the principal');
select is((select count(*)::int from api.v_approval_requests), 1, 'the history policy reveals nothing else');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select ok((select decided_by_me from api.v_approval_requests where request_id = current_setting('t.re')::uuid),
  'the principal sees the delegated decision as theirs');

-- ---------------------------------------------------------------------------
-- Notifications round trip for the requester
-- ---------------------------------------------------------------------------
select tests.clear_authentication();
select set_config('t.n4', (select array_agg(id)::text from notify.notifications
  where recipient_user_id = '00000000-0000-0000-0000-0000000000a4' and read_at is null), false);
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is(api.mark_notifications_read(current_setting('t.n4')::uuid[]), 0, 'nobody can mark another user''s notifications');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select link from api.v_notifications where type = 'approval.decided' and read_at is null
           and data ->> 'request_id' = current_setting('t.re')), '/approvals/' || current_setting('t.re'),
  'requester gets an unread approval.decided notification linking to the request');
select set_config('t.unread', (select count(*)::text from api.v_notifications where read_at is null), false);
select is(api.mark_notifications_read(array(select id from api.v_notifications where read_at is null)), current_setting('t.unread')::int,
  'mark_notifications_read marks every unread notification of the caller');
select is((select count(*)::int from api.v_notifications where read_at is null), 0, 'no unread notifications remain');
select is(api.mark_notifications_read(array(select id from api.v_notifications)), 0, 'marking again is a no-op');

select tests.clear_authentication();
select * from finish();
rollback;
