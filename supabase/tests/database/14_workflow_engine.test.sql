-- Generic approval engine: safe condition evaluator, rule selection, multi-stage, required approvals,
-- delegation, self-approval, inbox visibility, grant replica equivalence.
begin;
select tests.load_fixture();
select plan(59);

-- ---------------------------------------------------------------------------
-- Condition evaluator (data, never SQL)
-- ---------------------------------------------------------------------------
select is(wf.condition_matches('{}', '{"a":1}'), true, 'empty condition matches');
select is(wf.condition_matches(null, '{"a":1}'), true, 'NULL condition matches');
select is(wf.condition_matches('{"all":[{"field":"amount","op":">","value":1000}]}', '{"amount":1500}'), true, '> on numbers');
select is(wf.condition_matches('{"all":[{"field":"amount","op":">","value":1000}]}', '{"amount":1000}'), false, '> boundary is exclusive');
select is(wf.condition_matches('{"all":[{"field":"amount","op":">=","value":1000},{"field":"amount","op":"<","value":2000}]}', '{"amount":1000.00}'), true, 'all: every clause must hold (range)');
select is(wf.condition_matches('{"all":[{"field":"kind","op":"in","value":["clinic","lab"]}]}', '{"kind":"lab"}'), true, 'in list');
select is(wf.condition_matches('{"all":[{"field":"kind","op":"!=","value":"clinic"}]}', '{"kind":"clinic"}'), false, '!= on strings');
select is(wf.condition_matches('{"all":[{"field":"flag","op":"=","value":true}]}', '{"flag":true}'), true, '= on booleans');
select is(wf.condition_matches('{"all":[{"field":"order.total","op":"<=","value":10}]}', '{"order":{"total":10}}'), true, 'dotted path into payload');
select is(wf.condition_matches('{"all":[{"field":"amount","op":">","value":1}]}', '{}'), false, 'missing field → false');
select is(wf.condition_matches('[1,2]', '{"a":1}'), false, 'malformed: array condition → false');
select is(wf.condition_matches('{"any":[]}', '{"a":1}'), false, 'malformed: unknown combinator → false');
select is(wf.condition_matches('{"all":{"field":"a"}}', '{"a":1}'), false, 'malformed: all is not an array → false');
select is(wf.condition_matches('{"all":[{"field":"a","value":1}]}', '{"a":1}'), false, 'malformed: clause without op → false');
select is(wf.condition_matches('{"all":[{"field":"a","op":"like","value":"%"}]}', '{"a":"x"}'), false, 'malformed: unknown operator → false');
select is(wf.condition_matches('{"all":[{"field":"a","op":">","value":"10"}]}', '{"a":20}'), false, 'malformed: type mismatch → false');
select is(wf.condition_matches('{"all":[{"field":"a","op":"in","value":5}]}', '{"a":5}'), false, 'malformed: in without array → false');
select is(wf.condition_matches('{"all":[{"field":"a; drop table wf.approval_steps","op":"=","value":1}]}', '{"a":1}'), false,
  'SQL-looking field name is just an unknown field → false');
select ok(not has_function_privilege('authenticated', 'wf.condition_matches(jsonb, jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'wf.create_request(text, text, uuid, jsonb, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'wf.on_decided_sales_order_discount(uuid, boolean)', 'execute')
          and not has_function_privilege('authenticated', 'wf.on_decided_inventory_adjustment(uuid, boolean)', 'execute')
          and not has_function_privilege('authenticated', 'wf.on_decided_sales_order_cancel(uuid, boolean)', 'execute')
          and not has_function_privilege('authenticated', 'wf.dispatch_decision_hook(text, uuid, boolean)', 'execute'),
  'clients cannot execute the evaluator, request creation or decision hooks');
select ok(not has_function_privilege('anon', 'api.decide_approval(uuid, text, text)', 'execute')
          and has_function_privilege('authenticated', 'api.decide_approval(uuid, text, text)', 'execute'),
  'decide_approval is an authenticated-only command');

select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('wf','notify','inventory') and p.prorettype <> 'trigger'::regtype
             and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))
             and p.oid <> 'wf.can_decide(uuid)'::regprocedure), 0,
  'no wf/notify/inventory function is client-executable except wf.can_decide');

-- ---------------------------------------------------------------------------
-- wf.user_grants (used for delegators) equals authz.grants for every fixture user
-- ---------------------------------------------------------------------------
insert into authz.user_permission_overrides (user_id, permission_code, effect, reason)
values ('00000000-0000-0000-0000-0000000000a3', 'wf.decide.order_discount', 'deny', 'test deny');
insert into authz.user_permission_overrides (user_id, permission_code, effect, scope, limit_value, reason, expires_at)
values ('00000000-0000-0000-0000-0000000000a8', 'wf.decide.order_discount', 'grant', 'all', 7, 'test grant', now() + interval '1 day');
create temp table _grant_mismatch (u uuid, p text);
do $$
declare u uuid; p text;
begin
  foreach u in array array['00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2',
                           '00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000a4',
                           '00000000-0000-0000-0000-0000000000a5','00000000-0000-0000-0000-0000000000a6',
                           '00000000-0000-0000-0000-0000000000a7','00000000-0000-0000-0000-0000000000a8',
                           '00000000-0000-0000-0000-00000000ffff']::uuid[] loop
    foreach p in array array['wf.decide.order_discount','sales.order.read','inventory.adjustment.post',
                             'crm.customer.read','wf.approval.read','wf.decide.inventory_adjustment'] loop
      perform set_config('request.jwt.claim.sub', u::text, true);
      if exists ((select * from authz.grants(p) except all select * from wf.user_grants(u, p))
                 union all
                 (select * from wf.user_grants(u, p) except all select * from authz.grants(p))) then
        insert into _grant_mismatch values (u, p);
      end if;
    end loop;
  end loop;
  perform set_config('request.jwt.claim.sub', '', true);
end $$;
select is((select count(*)::int from _grant_mismatch), 0, 'wf.user_grants(user, perm) = authz.grants(perm) as that user (roles, overrides, deny, owner)');
delete from authz.user_permission_overrides where reason in ('test deny', 'test grant');

-- ---------------------------------------------------------------------------
-- Test workflows (created here, not seeded)
--   test.multi  rule 10: amount > 1000 → stage 1 requester's manager, stage 2 two holders of wf.decide.test_multi
--               rule 20: {}           → stage 1 user a2 (sales director)
--   test.role   rule 10: {}           → stage 1 role inventory_manager
--   test.auto   rule 10: {} auto_approve
-- ---------------------------------------------------------------------------
insert into authz.permissions (code, module, description) values ('wf.decide.test_multi', 'wf', 'test-only approval permission');
insert into wf.workflow_definitions (id, code, name, entity_type) values
  ('a1000000-0000-0000-0000-000000000001', 'test.multi', 'Test multi-stage', 'test'),
  ('a1000000-0000-0000-0000-000000000002', 'test.role',  'Test role stage', 'test'),
  ('a1000000-0000-0000-0000-000000000003', 'test.auto',  'Test auto approve', 'test');
insert into wf.workflow_rules (id, definition_id, priority, condition, auto_approve) values
  ('a2000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 10, '{"all":[{"field":"amount","op":">","value":1000}]}', false),
  ('a2000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001', 20, '{}', false),
  ('a2000000-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-000000000002', 10, '{}', false),
  ('a2000000-0000-0000-0000-000000000004', 'a1000000-0000-0000-0000-000000000003', 10, '{}', true);
insert into wf.workflow_stages (rule_id, stage_no, approver_type, approver_permission, approver_user_id, approver_role_id, required_approvals) values
  ('a2000000-0000-0000-0000-000000000001', 1, 'requester_manager', null, null, null, 1),
  ('a2000000-0000-0000-0000-000000000001', 2, 'permission', 'wf.decide.test_multi', null, null, 2),
  ('a2000000-0000-0000-0000-000000000002', 1, 'user', null, '00000000-0000-0000-0000-0000000000a2', null, 1),
  ('a2000000-0000-0000-0000-000000000003', 1, 'role', null, null, (select id from authz.roles where code = 'inventory_manager'), 1);
insert into authz.user_permission_overrides (user_id, permission_code, effect, scope, reason) values
  ('00000000-0000-0000-0000-0000000000a6', 'wf.decide.test_multi', 'grant', 'all', 'test approver'),
  ('00000000-0000-0000-0000-0000000000a8', 'wf.decide.test_multi', 'grant', 'all', 'test approver');

-- Requests raised by rep a4 (manager: area manager a3). Created as the service would (internal function).
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a4', true);
select ok(wf.create_request('test.multi', 'test', 'b0000000-0000-0000-0000-000000000001', '{"amount":5000}') is not null, 'request 1 created');
select wf.create_request('test.multi', 'test', 'b0000000-0000-0000-0000-000000000002', '{"amount":10}');
select wf.create_request('test.multi', 'test', 'b0000000-0000-0000-0000-000000000003', '{"amount":20}');
select wf.create_request('test.multi', 'test', 'b0000000-0000-0000-0000-000000000004', '{"amount":2000}');
select wf.create_request('test.multi', 'test', 'b0000000-0000-0000-0000-000000000005', '{"amount":3000}');
select wf.create_request('test.role',  'test', 'b0000000-0000-0000-0000-000000000006', '{}');
select is(wf.create_request('test.multi', 'test', 'b0000000-0000-0000-0000-000000000001', '{"amount":5000}'),
          (select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000001'),
          'creating again while pending returns the same request');
select wf.create_request('test.auto', 'test', 'b0000000-0000-0000-0000-000000000007', '{}');
select set_config('request.jwt.claim.sub', '', true);
select is((select status from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000007'),
          'approved', 'auto_approve rule approves at creation');

select is((select rule_id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000001'),
          'a2000000-0000-0000-0000-000000000001'::uuid, 'first matching rule by priority chosen (amount > 1000)');
select is((select rule_id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000002'),
          'a2000000-0000-0000-0000-000000000002'::uuid, 'fallback rule chosen when the condition does not match');
select is((select count(*)::int from integration.outbox where event_type = 'approval.requested'
           and aggregate_id = (select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000001')), 1,
          'approval.requested emitted');
select is((select count(*)::int from notify.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000a3'
           and type = 'approval.requested'), 3, 'requester''s manager notified for each manager-stage request (1, 4, 5)');

-- ---------------------------------------------------------------------------
-- Request 1: two stages, the second needs two distinct approvers
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.decide_approval((select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000001'), 'approve')$$,
  '42501', null, 'requester cannot decide own request');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000001'), 'approve')$$,
  'SELF_APPROVAL%', 'self-approval is reported as SELF_APPROVAL');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000001'), 'approve')$$,
  'PERMISSION_DENIED%', 'sales director is not the requester''s manager (stage 1)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(api.decide_approval((select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000001'), 'approve', 'ok') ->> 'current_stage',
  '2', 'manager approval advances to stage 2');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000001'), 'approve')$$,
  'PERMISSION_DENIED%', 'manager lacks the stage-2 permission');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(api.decide_approval((select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000001'), 'approve') ->> 'status',
  'pending', 'one of two required approvals keeps the request pending');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000001'), 'approve')$$,
  'ALREADY_DECIDED%', 'the same approver cannot count twice');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(api.decide_approval((select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000001'), 'approve') ->> 'status',
  'approved', 'second distinct approver finishes the last stage');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000001'), 'reject')$$,
  'INVALID_STATE%', 'a decided request cannot be decided again');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000005'), 'maybe')$$,
  'VALIDATION%', 'decision must be approve or reject');
select throws_ok($$select api.decide_approval('ffffffff-0000-0000-0000-000000000000', 'approve')$$,
  'P0002', null, 'unknown request → NOT_FOUND (P0002)');

-- Requester sees the trail of their own request
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from wf.approval_steps
           where request_id = (select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000001')), 3,
  'requester sees all three approval steps');
select is((select count(*)::int from api.v_notifications where type = 'approval.decided'), 1,
  'requester notified of the final decision of request 1');
select tests.clear_authentication();
select is((select count(*)::int from integration.outbox where event_type = 'approval.decided'
           and aggregate_id = (select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000001')), 1,
  'approval.decided emitted once');

-- ---------------------------------------------------------------------------
-- Request 2: single 'user' stage; delegation within validity → on_behalf_of recorded
-- Request 3: expired delegation grants nothing; rejection ends the request
-- ---------------------------------------------------------------------------
insert into wf.delegations (from_user_id, to_user_id, definition_id, valid_from, valid_to) values
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a7', 'a1000000-0000-0000-0000-000000000001',
   now() - interval '1 hour', now() + interval '1 day'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a6', 'a1000000-0000-0000-0000-000000000001',
   now() - interval '2 days', now() - interval '1 minute');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000002'), 'approve')$$,
  'PERMISSION_DENIED%', 'only the named user decides a user stage');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is(api.decide_approval((select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000002'), 'approve') ->> 'on_behalf_of',
  '00000000-0000-0000-0000-0000000000a2', 'delegate approves on behalf of the delegator');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000003'), 'approve')$$,
  'PERMISSION_DENIED%', 'expired delegation grants nothing');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(api.decide_approval((select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000003'), 'reject', 'no') ->> 'status',
  'rejected', 'rejection ends the request');
select tests.clear_authentication();
select is((select on_behalf_of from wf.approval_steps
           where request_id = (select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000002')),
  '00000000-0000-0000-0000-0000000000a2'::uuid, 'step stores on_behalf_of = delegator');

-- Request 4: rejection at stage 1 of a two-stage rule ends it immediately
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(api.decide_approval((select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000004'), 'reject') ->> 'status',
  'rejected', 'rejection at the first of two stages rejects the request');

-- Request 6: role stage
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000006'), 'approve')$$,
  'PERMISSION_DENIED%', 'role stage: users without the role cannot decide');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(api.decide_approval((select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000006'), 'approve') ->> 'status',
  'approved', 'role stage: a holder of the role decides');
select tests.clear_authentication();

-- Request without a rule (legacy/external creator): rule resolved and fixed at first decision
insert into wf.approval_requests (definition_id, entity_type, entity_id, requested_by, payload, subject_employee_id)
values ('a1000000-0000-0000-0000-000000000001', 'test', 'b0000000-0000-0000-0000-000000000008',
        '00000000-0000-0000-0000-0000000000a4', '{"amount":9000}', '20000000-0000-0000-0000-000000000004');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(api.decide_approval((select id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000008'), 'approve') ->> 'current_stage',
  '2', 'request created without rule_id: rule matched by condition at decision time');
select tests.clear_authentication();
select is((select rule_id from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000008'),
  'a2000000-0000-0000-0000-000000000001'::uuid, 'resolved rule is persisted on the request');

-- ---------------------------------------------------------------------------
-- Inbox visibility (request 5 pending at the manager stage)
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select can_decide from api.v_approvals_inbox where entity_id = 'b0000000-0000-0000-0000-000000000005'), true,
  'manager sees request 5 in the inbox as decidable');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from api.v_approvals_inbox where entity_id = 'b0000000-0000-0000-0000-000000000005'), 0,
  'sales director cannot decide request 5, so it is not in the inbox');
select is((select count(*)::int from wf.approval_requests where entity_id = 'b0000000-0000-0000-0000-000000000005'), 1,
  'sales director can still read it (wf.approval.read all)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select is_mine and not can_decide from api.v_approvals_inbox where entity_id = 'b0000000-0000-0000-0000-000000000005'), true,
  'requester sees own request, not decidable');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from wf.approval_requests) + (select count(*)::int from api.v_approvals_inbox), 0,
  'unrelated rep sees no requests at all');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is((select count(*)::int from api.v_approvals_inbox where entity_id = 'b0000000-0000-0000-0000-000000000005'), 0,
  'a delegate of the sales director cannot decide the manager stage');
select tests.clear_authentication();

select * from finish();
rollback;
