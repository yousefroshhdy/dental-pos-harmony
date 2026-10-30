-- Workflow administration: rules editor validation and anti-escalation, delegation (window,
-- revocation, self-approval, separation of duties, scope), escalation job (threshold, levels,
-- fallback, owners, idempotency), read views and privileges.
-- Fixture users: a1 owner · a2 sales director · a3 area manager (manager of a4) · a4 rep Cairo
--                a5 rep Delta · a6 finance · a7 admin · a8 inventory manager
begin;
select tests.load_fixture();
select plan(94);

-- ---------------------------------------------------------------------------
-- Test workflows (created here, not seeded). Every definition has a catch-all rule.
--   test.wfa  rule 100 {}: stage 1 user a3 · stage 2 permission wf.decide.test_wfa (a3, a6, a8 hold it)
--   test.wfe  rule 100 {}: stage 1 user a3 (escalation set below through the command)
--   test.wfp  rule 100 {}: stage 1 permission wf.decide.test_wfa (escalation without fallback → owners)
--   test.wff  rule 100 {}: stage 1 user a3 (escalation with fallback a6)
-- ---------------------------------------------------------------------------
insert into authz.permissions (code, module, description) values ('wf.decide.test_wfa', 'wf', 'test-only approval permission');
insert into wf.workflow_definitions (id, code, name, entity_type) values
  ('c1000000-0000-0000-0000-000000000001', 'test.wfa', 'Test two stages', 'test'),
  ('c1000000-0000-0000-0000-000000000002', 'test.wfe', 'Test escalation', 'test'),
  ('c1000000-0000-0000-0000-000000000003', 'test.wfp', 'Test escalation to owners', 'test'),
  ('c1000000-0000-0000-0000-000000000004', 'test.wff', 'Test escalation fallback', 'test');
insert into wf.workflow_rules (id, definition_id, priority, condition) values
  ('c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 100, '{}'),
  ('c2000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002', 100, '{}'),
  ('c2000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000003', 100, '{}'),
  ('c2000000-0000-0000-0000-000000000004', 'c1000000-0000-0000-0000-000000000004', 100, '{}');
insert into wf.workflow_stages (rule_id, stage_no, approver_type, approver_permission, approver_user_id) values
  ('c2000000-0000-0000-0000-000000000001', 1, 'user', null, '00000000-0000-0000-0000-0000000000a3'),
  ('c2000000-0000-0000-0000-000000000001', 2, 'permission', 'wf.decide.test_wfa', null),
  ('c2000000-0000-0000-0000-000000000002', 1, 'user', null, '00000000-0000-0000-0000-0000000000a3'),
  ('c2000000-0000-0000-0000-000000000003', 1, 'permission', 'wf.decide.test_wfa', null),
  ('c2000000-0000-0000-0000-000000000004', 1, 'user', null, '00000000-0000-0000-0000-0000000000a3');
insert into authz.user_permission_overrides (user_id, permission_code, effect, scope, reason) values
  ('00000000-0000-0000-0000-0000000000a3', 'wf.decide.test_wfa', 'grant', 'all', 'test approver'),
  ('00000000-0000-0000-0000-0000000000a6', 'wf.decide.test_wfa', 'grant', 'all', 'test approver'),
  ('00000000-0000-0000-0000-0000000000a8', 'wf.decide.test_wfa', 'grant', 'all', 'test approver');

-- ---------------------------------------------------------------------------
-- Privileges and seeded grants
-- ---------------------------------------------------------------------------
select ok(has_function_privilege('authenticated', 'api.upsert_workflow_rule(text, int, jsonb, boolean, uuid, jsonb, text)', 'execute')
          and has_function_privilege('authenticated', 'api.set_workflow_stage(uuid, int, text, text, uuid, uuid, int, int, uuid, boolean, text)', 'execute')
          and has_function_privilege('authenticated', 'api.create_delegation(uuid, timestamptz, timestamptz, text[], uuid, text, text)', 'execute')
          and has_function_privilege('authenticated', 'api.revoke_delegation(uuid, text)', 'execute')
          and not has_function_privilege('anon', 'api.create_delegation(uuid, timestamptz, timestamptz, text[], uuid, text, text)', 'execute')
          and not has_function_privilege('anon', 'api.upsert_workflow_rule(text, int, jsonb, boolean, uuid, jsonb, text)', 'execute'),
  'workflow admin and delegation commands are authenticated-only');
select ok(not has_function_privilege('authenticated', 'service.workflow_escalate(int)', 'execute')
          and not has_function_privilege('anon', 'service.workflow_escalate(int)', 'execute')
          and has_function_privilege('service_role', 'service.workflow_escalate(int)', 'execute'),
  'the escalation job is service_role only');
select ok(not has_function_privilege('authenticated', 'wf.put_stage(uuid, int, text, text, uuid, uuid, int, int, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'wf.condition_error(jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'wf.resolve_principal(uuid)', 'execute'),
  'internal workflow helpers are not client-callable');
select is((select count(*)::int from authz.role_permissions rp join authz.roles r on r.id = rp.role_id
           where rp.permission_code = 'wf.delegation.manage'
             and (r.code, rp.scope) in (('sales_director','team'), ('area_manager','own'),
                                        ('inventory_manager','own'), ('finance_officer','own'))), 4,
  'approver roles may delegate (sales director also for his team)');
select is((select count(*)::int from authz.role_permissions rp join authz.roles r on r.id = rp.role_id
           where rp.permission_code = 'wf.delegation.manage' and r.code in ('admin','sales_rep')), 0,
  'IT admin and reps cannot delegate approvals');

-- ---------------------------------------------------------------------------
-- Rules editor: authorization and validation
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select throws_ok($$select api.upsert_workflow_rule('test.wfa', 50, '{}', false, null,
  '[{"approver_type":"requester_manager"}]', 'test')$$, '42501', null,
  'non-admin (sales director) cannot edit workflow rules');
select throws_ok($$select api.set_workflow_stage('c2000000-0000-0000-0000-000000000001', 3, 'requester_manager',
  p_reason => 'test')$$, '42501', null, 'non-admin cannot edit stages');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select throws_like($$select api.upsert_workflow_rule('test.wfa', 50, '{}', false, null, '[{"approver_type":"requester_manager"}]')$$,
  'REASON_REQUIRED%', 'a workflow change needs a reason');
select throws_ok($$select api.upsert_workflow_rule('test.nope', 50, '{}', false, null, null, 'test')$$,
  'P0002', null, 'unknown workflow → NOT_FOUND');
select throws_like($$select api.upsert_workflow_rule('test.wfa', 50, '{"any":[]}', false, null,
  '[{"approver_type":"requester_manager"}]', 'test')$$, 'INVALID_CONDITION%', 'unknown combinator is refused');
select throws_like($$select api.upsert_workflow_rule('test.wfa', 50, '{"all":[{"field":"amount","op":"like","value":"%"}]}', false, null,
  '[{"approver_type":"requester_manager"}]', 'test')$$, 'INVALID_CONDITION%', 'unknown operator is refused');
select throws_like($$select api.upsert_workflow_rule('test.wfa', 50, '{"all":[{"field":"a; drop table x","op":"=","value":1}]}', false, null,
  '[{"approver_type":"requester_manager"}]', 'test')$$, 'INVALID_CONDITION%', 'SQL-looking field name is refused');
select throws_like($$select api.upsert_workflow_rule('test.wfa', 50, '{"all":[{"field":"kind","op":"in","value":[]}]}', false, null,
  '[{"approver_type":"requester_manager"}]', 'test')$$, 'INVALID_CONDITION%', '"in" with an empty list is refused');
select throws_like($$select api.upsert_workflow_rule('test.wfa', 50, '{"all":[{"field":"flag","op":">","value":true}]}', false, null,
  '[{"approver_type":"requester_manager"}]', 'test')$$, 'INVALID_CONDITION%', 'boolean with > is refused');
select throws_like($$select api.upsert_workflow_rule('test.wfa', 50, '{"all":[{"field":"amount","op":">"}]}', false, null,
  '[{"approver_type":"requester_manager"}]', 'test')$$, 'INVALID_CONDITION%', 'clause without a value is refused');
select throws_like($$select api.upsert_workflow_rule('test.wfa', 0, '{}', false, null, '[{"approver_type":"requester_manager"}]', 'test')$$,
  'VALIDATION%', 'priority must be positive');
select throws_like($$select api.upsert_workflow_rule('test.wfa', 50, '{"all":[{"field":"amount","op":">","value":1000}]}', false, null, null, 'test')$$,
  'VALIDATION%', 'a new rule needs at least one stage');
select throws_like($$select api.upsert_workflow_rule('test.wfa', 100, '{"all":[{"field":"amount","op":">","value":1000}]}', false, null,
  '[{"approver_type":"requester_manager"}]', 'test')$$, 'DUPLICATE%', 'priority clash within a workflow is refused');
select throws_like($$select api.upsert_workflow_rule('test.wfa', 100, '{"all":[{"field":"amount","op":">","value":1}]}', false,
  'c2000000-0000-0000-0000-000000000001', null, 'test')$$, 'CATCH_ALL_REQUIRED%', 'the last catch-all rule cannot get a condition');
select throws_like($$select api.upsert_workflow_rule('test.wfa', 60, '{}', true, null, null, 'test')$$,
  'OWNER_ONLY%', 'only an owner may create an auto-approve rule');
select throws_like($$select api.upsert_workflow_rule('test.wfa', 50, '{"all":[{"field":"amount","op":">","value":1000}]}', false, null,
  '[{"approver_type":"permission","approver_permission":"admin.user.read"}]', 'test')$$,
  'VALIDATION%', 'a permission stage must use a wf.decide.* permission');
select throws_like($$select api.upsert_workflow_rule('test.wfa', 50, '{"all":[{"field":"amount","op":">","value":1000}]}', false, null,
  '[{"approver_type":"user","approver_user_id":"00000000-0000-0000-0000-0000000000a7"}]', 'test')$$,
  'ESCALATION_BLOCKED%', 'an admin cannot name themselves as approver');
select throws_like($$select api.upsert_workflow_rule('test.wfa', 50, '{"all":[{"field":"amount","op":">","value":1000}]}', false, null,
  format('[{"approver_type":"role","approver_role_id":"%s"}]', (select id from authz.roles where code = 'admin'))::jsonb, 'test')$$,
  'ESCALATION_BLOCKED%', 'an admin cannot route a stage to a role they hold');
select throws_like($$select api.upsert_workflow_rule('test.wfa', 50, '{"all":[{"field":"amount","op":">","value":1000}]}', false, null,
  '[{"approver_type":"user","approver_user_id":"00000000-0000-0000-0000-0000000000a2","required_approvals":2}]', 'test')$$,
  'VALIDATION%', 'a single named user gives exactly one approval');

-- A valid conditional rule: amount > 1000 → stage 1 sales director, stage 2 two wf.decide.test_wfa holders
select is((api.upsert_workflow_rule('test.wfa', 50, '{"all":[{"field":"amount","op":">","value":1000}]}', false, null,
  '[{"approver_type":"user","approver_user_id":"00000000-0000-0000-0000-0000000000a2"},
    {"approver_type":"permission","approver_permission":"wf.decide.test_wfa","required_approvals":2}]', 'large amounts')) ->> 'created',
  'true', 'admin creates a conditional rule with its stages');
select is((select stage_count from api.v_workflow_rules where workflow_code = 'test.wfa' and priority = 50), 2,
  'the new rule is listed with two stages');
select is((select required_approvals from api.v_workflow_stages s join api.v_workflow_rules r on r.rule_id = s.rule_id
           where r.workflow_code = 'test.wfa' and r.priority = 50 and s.stage_no = 2), 2,
  'stage 2 keeps its required approvals');
select is((select priority from api.v_workflow_rules where workflow_code = 'test.wfa' and rule_id <> 'c2000000-0000-0000-0000-000000000001'),
  50, 'only one new rule exists');
select is((api.upsert_workflow_rule('test.wfa', 40, '{"all":[{"field":"amount","op":">=","value":2000}]}', false,
  (select rule_id from api.v_workflow_rules where workflow_code = 'test.wfa' and priority = 50), null, 'tighten')) ->> 'created',
  'false', 'admin edits the rule (priority and condition)');
select is((select condition from api.v_workflow_rules where workflow_code = 'test.wfa' and priority = 40),
  '{"all":[{"field":"amount","op":">=","value":2000}]}'::jsonb, 'the condition is stored as data');

-- Stages through api.set_workflow_stage
select throws_like($$select api.set_workflow_stage('c2000000-0000-0000-0000-000000000001', 3, 'user', null, null,
  '00000000-0000-0000-0000-0000000000a2', 1, null, '00000000-0000-0000-0000-0000000000a6', false, 'test')$$,
  'VALIDATION%', 'an escalation fallback needs an escalate-after time');
select throws_like($$select api.set_workflow_stage('c2000000-0000-0000-0000-000000000001', 3, 'user', null, null,
  '00000000-0000-0000-0000-0000000000a2', 1, 5, null, false, 'test')$$,
  'VALIDATION%', 'escalate-after is at least 15 minutes');
select throws_like($$select api.set_workflow_stage('c2000000-0000-0000-0000-000000000002', 1, 'user', null, null,
  '00000000-0000-0000-0000-0000000000a3', 1, 60, '00000000-0000-0000-0000-0000000000a7', false, 'test')$$,
  'ESCALATION_BLOCKED%', 'an admin cannot make themselves the escalation fallback');
select is((api.set_workflow_stage('c2000000-0000-0000-0000-000000000002', 1, 'user', null, null,
  '00000000-0000-0000-0000-0000000000a3', 1, 60, null, false, 'escalate after an hour')) ->> 'removed', 'false',
  'admin sets escalate_after on a stage');
select is((select escalate_after_minutes from api.v_workflow_stages where rule_id = 'c2000000-0000-0000-0000-000000000002'), 60,
  'escalate_after is shown in minutes');
select lives_ok($$select api.set_workflow_stage('c2000000-0000-0000-0000-000000000003', 1, 'permission', 'wf.decide.test_wfa',
  null, null, 1, 60, null, false, 'escalate after an hour')$$, 'permission stage with escalation, no fallback');
select lives_ok($$select api.set_workflow_stage('c2000000-0000-0000-0000-000000000004', 1, 'user', null, null,
  '00000000-0000-0000-0000-0000000000a3', 1, 60, '00000000-0000-0000-0000-0000000000a6', false, 'fallback to finance')$$,
  'user stage with an escalation fallback');
select throws_like($$select api.set_workflow_stage('c2000000-0000-0000-0000-000000000002', 1, p_remove => true, p_reason => 'test')$$,
  'VALIDATION%', 'the last stage of a rule cannot be removed');
select tests.clear_authentication();

select is((select version from wf.workflow_definitions where code = 'test.wfa'), 3, 'each change bumps the definition version');
select is((select count(*)::int from audit.audit_log where table_name = 'workflow_rules'
           and record_id = (select rule_id::text from api.v_workflow_rules where workflow_code = 'test.wfa' and priority = 40)), 2,
  'rule changes are audited (insert + update)');
select is((select count(*)::int from audit.security_events where event_type = 'workflow_changed'
           and user_id = '00000000-0000-0000-0000-0000000000a7'), 5,
  'every successful change writes a security event with its reason');
select ok((select count(*) from notify.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000a1'
           and type = 'workflow.changed') = 5, 'the owner is notified of each admin workflow change');

-- The engine routes by the stored condition
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a4', true);
select wf.create_request('test.wfa', 'test', 'c3000000-0000-0000-0000-000000000001', '{"amount":5000}');
select wf.create_request('test.wfa', 'test', 'c3000000-0000-0000-0000-000000000002', '{"amount":10}');
select set_config('request.jwt.claim.sub', '', true);
select is((select r.priority from wf.approval_requests q join wf.workflow_rules r on r.id = q.rule_id
           where q.entity_id = 'c3000000-0000-0000-0000-000000000001'), 40, 'a matching request takes the edited rule');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select throws_like($$select api.set_workflow_stage((select rule_id from api.v_workflow_rules where workflow_code = 'test.wfa' and priority = 40),
  2, p_remove => true, p_reason => 'test')$$, 'RULE_IN_USE%', 'a stage cannot be removed while a request on the rule is pending');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((api.upsert_workflow_rule('test.wfa', 10, '{"all":[{"field":"amount","op":"<","value":0}]}', true, null, null, 'owner auto')) ->> 'created',
  'true', 'an owner may create an auto-approve rule');
select tests.clear_authentication();

-- ---------------------------------------------------------------------------
-- Delegation: scope and validation
--   a3 (area manager) delegates test.wfa to a8 (inventory manager)
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.create_delegation('20000000-0000-0000-0000-000000000003', now(), now() + interval '1 day')$$,
  '42501', null, 'a rep cannot create delegations');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_ok($$select api.create_delegation('20000000-0000-0000-0000-000000000008', now(), now() + interval '1 day', null,
  '20000000-0000-0000-0000-000000000002')$$, '42501', null, 'an area manager cannot delegate for his own manager');
select throws_like($$select api.create_delegation('20000000-0000-0000-0000-000000000008', now() + interval '2 days', now() + interval '1 day')$$,
  'VALIDATION%', 'a delegation must end after it starts');
select throws_like($$select api.create_delegation('20000000-0000-0000-0000-000000000008', now(), now() + interval '120 days')$$,
  'VALIDATION%', 'a delegation lasts at most 90 days');
select throws_like($$select api.create_delegation('20000000-0000-0000-0000-000000000003', now(), now() + interval '1 day')$$,
  'VALIDATION%', 'nobody delegates to themselves');
select throws_ok($$select api.create_delegation('20000000-0000-0000-0000-000000000008', now(), now() + interval '1 day', array['test.nope'])$$,
  'P0002', null, 'unknown workflow code → NOT_FOUND');
-- Scheduled (future) delegation
select is(jsonb_array_length(api.create_delegation('20000000-0000-0000-0000-000000000008', now() + interval '1 hour', now() + interval '1 day',
  array['test.wfa'], null, 'leave', 'ref-1') -> 'delegation_ids'), 1, 'area manager delegates test.wfa to the inventory manager');
select is((api.create_delegation('20000000-0000-0000-0000-000000000008', now() + interval '1 hour', now() + interval '1 day',
  array['test.wfa'], null, 'leave', 'ref-1')) ->> 'replayed', 'true', 'same client_ref replays the delegation');
select throws_like($$select api.create_delegation('20000000-0000-0000-0000-000000000008', now(), now() + interval '2 days')$$,
  'DUPLICATE%', 'an overlapping delegation to the same person is refused');
select is((select status from api.v_delegations where is_from_me and to_user_id = '00000000-0000-0000-0000-0000000000a8'), 'scheduled',
  'a future delegation is shown as scheduled');

-- ---------------------------------------------------------------------------
-- Delegation: window, separation of duties, self-approval
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = 'c3000000-0000-0000-0000-000000000002'), 'approve')$$,
  'PERMISSION_DENIED%', 'before its window opens the delegation grants nothing');
select tests.clear_authentication();
update wf.delegations set valid_from = now() - interval '1 hour'
where from_user_id = '00000000-0000-0000-0000-0000000000a3' and to_user_id = '00000000-0000-0000-0000-0000000000a8';

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is((select my_verdict from api.v_approval_requests where entity_id = 'c3000000-0000-0000-0000-000000000002'), 'ok',
  'inside the window the delegate can decide the delegator''s stage');
select is(api.decide_approval((select id from wf.approval_requests where entity_id = 'c3000000-0000-0000-0000-000000000002'), 'approve') ->> 'on_behalf_of',
  '00000000-0000-0000-0000-0000000000a3', 'the delegate approves stage 1 on behalf of the area manager');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = 'c3000000-0000-0000-0000-000000000002'), 'approve')$$,
  'ALREADY_DECIDED%', 'separation of duties: the delegate cannot also decide stage 2 with his own permission');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = 'c3000000-0000-0000-0000-000000000002'), 'approve')$$,
  'ALREADY_DECIDED%', 'separation of duties: the delegator cannot decide stage 2 after his delegate decided stage 1');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(api.decide_approval((select id from wf.approval_requests where entity_id = 'c3000000-0000-0000-0000-000000000002'), 'approve') ->> 'status',
  'approved', 'a third person finishes stage 2');

-- Self-approval: a3 delegates to his rep a4; a4's own request and a request about a4 stay out of reach
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select lives_ok($$select api.create_delegation('20000000-0000-0000-0000-000000000004', now(), now() + interval '1 day', array['test.wfa'])$$,
  'area manager delegates to his rep');
select tests.clear_authentication();
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a4', true);
select wf.create_request('test.wfa', 'test', 'c3000000-0000-0000-0000-000000000003', '{"amount":20}');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a5', true);
select wf.create_request('test.wfa', 'test', 'c3000000-0000-0000-0000-000000000004', '{"amount":30}', '20000000-0000-0000-0000-000000000004');
select set_config('request.jwt.claim.sub', '', true);
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = 'c3000000-0000-0000-0000-000000000003'), 'approve')$$,
  'SELF_APPROVAL%', 'a delegate cannot approve their own request');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = 'c3000000-0000-0000-0000-000000000004'), 'approve')$$,
  'SELF_APPROVAL%', 'a delegate cannot approve a request about themselves');

-- Expired and revoked delegations grant nothing
select tests.clear_authentication();
update wf.delegations set valid_from = now() - interval '2 days', valid_to = now() - interval '1 minute'
where from_user_id = '00000000-0000-0000-0000-0000000000a3' and to_user_id = '00000000-0000-0000-0000-0000000000a8';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = 'c3000000-0000-0000-0000-000000000004'), 'approve')$$,
  'PERMISSION_DENIED%', 'after its window closes the delegation grants nothing');
select is((select status from api.v_delegations where to_user_id = '00000000-0000-0000-0000-0000000000a8'), 'ended',
  'the delegate sees the delegation as ended');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select lives_ok($$select api.create_delegation('20000000-0000-0000-0000-000000000006', now(), now() + interval '1 day', array['test.wfa'], null, 'cover')$$,
  'area manager delegates to finance');
select tests.clear_authentication();
select set_config('test.del_a6', (select id::text from wf.delegations where to_user_id = '00000000-0000-0000-0000-0000000000a6'), true);
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_ok($$select api.revoke_delegation(current_setting('test.del_a6')::uuid)$$,
  '42501', null, 'an unrelated user cannot end someone''s delegation');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((api.revoke_delegation((select id from api.v_delegations where to_user_id = '00000000-0000-0000-0000-0000000000a6'), 'back')) ->> 'status',
  'revoked', 'the delegator ends the delegation');
select is((api.revoke_delegation((select id from api.v_delegations where to_user_id = '00000000-0000-0000-0000-0000000000a6'))) ->> 'replayed',
  'true', 'ending it again is a no-op');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = 'c3000000-0000-0000-0000-000000000004'), 'approve')$$,
  'PERMISSION_DENIED%', 'a revoked delegation grants nothing');

-- Managers: team scope, and no self-grant through someone else's authority
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select throws_like($$select api.create_delegation('20000000-0000-0000-0000-000000000002', now(), now() + interval '1 day', null,
  '20000000-0000-0000-0000-000000000003')$$, 'SELF_GRANT_FORBIDDEN%', 'a manager cannot delegate a report''s authority to himself');
select is((api.create_delegation('20000000-0000-0000-0000-000000000005', now(), now() + interval '1 day', null,
  '20000000-0000-0000-0000-000000000003', 'cover for the area manager')) ->> 'from_user_id',
  '00000000-0000-0000-0000-0000000000a3', 'the sales director sets up a delegation for his area manager');
select is((select count(*)::int from api.v_delegations where from_user_id = '00000000-0000-0000-0000-0000000000a3'), 4,
  'the sales director sees his team''s delegations');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from api.v_delegations), 1, 'a delegate sees only the delegation to him');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is((select count(*)::int from api.v_delegations), 1, 'an inventory manager sees only his own delegation');
select tests.clear_authentication();
select is((select count(*)::int from audit.audit_log where table_name = 'delegations'), 7,
  'delegation inserts, window changes and revocations are audited');

-- ---------------------------------------------------------------------------
-- Escalation
--   E1 test.wfe (user a3, 60 min) waiting 90 min · E2 test.wfe waiting 10 min
--   P1 test.wfp (permission, 60 min, no fallback) waiting 90 min · F1 test.wff (fallback a6) waiting 90 min
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a4', true);
select wf.create_request('test.wfe', 'test', 'c4000000-0000-0000-0000-000000000001', '{}');
select wf.create_request('test.wfe', 'test', 'c4000000-0000-0000-0000-000000000002', '{}');
select wf.create_request('test.wfp', 'test', 'c4000000-0000-0000-0000-000000000003', '{}');
select wf.create_request('test.wff', 'test', 'c4000000-0000-0000-0000-000000000004', '{}');
select set_config('request.jwt.claim.sub', '', true);
update wf.approval_requests set created_at = now() - interval '90 minutes'
where entity_id in ('c4000000-0000-0000-0000-000000000001', 'c4000000-0000-0000-0000-000000000003', 'c4000000-0000-0000-0000-000000000004');
update wf.approval_requests set created_at = now() - interval '10 minutes' where entity_id = 'c4000000-0000-0000-0000-000000000002';

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is((select my_verdict from api.v_approval_requests where entity_id = 'c4000000-0000-0000-0000-000000000001'), 'not_approver',
  'before escalation the sales director is not an approver of the area manager''s stage');
select tests.clear_authentication();

select is(service.workflow_escalate() ->> 'escalated', '3', 'requests past escalate_after are escalated, the recent one is not');
select is((select target_user_ids from wf.approval_escalations e join wf.approval_requests r on r.id = e.request_id
           where r.entity_id = 'c4000000-0000-0000-0000-000000000001'), array['00000000-0000-0000-0000-0000000000a2']::uuid[],
  'a user stage escalates to the approver''s manager');
select is((select basis || ':' || array_to_string(target_user_ids, ',') from wf.approval_escalations e join wf.approval_requests r on r.id = e.request_id
           where r.entity_id = 'c4000000-0000-0000-0000-000000000004'), 'fallback:00000000-0000-0000-0000-0000000000a6',
  'the configured fallback takes precedence');
select is((select basis || ':' || array_to_string(target_user_ids, ',') from wf.approval_escalations e join wf.approval_requests r on r.id = e.request_id
           where r.entity_id = 'c4000000-0000-0000-0000-000000000003'), 'owners:00000000-0000-0000-0000-0000000000a1',
  'a permission stage without fallback escalates to the owners');
select is((select count(*)::int from notify.notifications where type = 'approval.escalated'
           and recipient_user_id = '00000000-0000-0000-0000-0000000000a2'), 1, 'the escalation target is notified');
select is((select count(*)::int from integration.outbox where event_type = 'approval.escalated'), 3, 'approval.escalated is emitted per escalation');
select is(service.workflow_escalate() ->> 'escalated', '0', 'a second run escalates nothing (idempotent)');
select is((select count(*)::int from wf.approval_escalations), 3, 'no duplicate escalation rows');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is((select i_am_target and is_open and can_decide from api.v_approval_escalations
           where entity_id = 'c4000000-0000-0000-0000-000000000001'), true,
  'the target sees the open escalation and can decide it');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is((select count(*)::int from api.v_approval_escalations), 0, 'someone neither involved nor an approver sees no escalations');
select tests.clear_authentication();

-- Level 2 after twice the threshold: the previous target's manager (the owner)
update wf.approval_requests set created_at = now() - interval '150 minutes' where entity_id = 'c4000000-0000-0000-0000-000000000001';
select is(service.workflow_escalate() ->> 'escalated', '1', 'after 2 × escalate_after the request escalates one more level');
select is((select target_user_ids from wf.approval_escalations e join wf.approval_requests r on r.id = e.request_id
           where r.entity_id = 'c4000000-0000-0000-0000-000000000001' and e.level = 2), array['00000000-0000-0000-0000-0000000000a1']::uuid[],
  'level 2 goes to the manager of the level-1 target');
select is(service.workflow_escalate() ->> 'escalated', '0', 'level 3 waits for 3 × escalate_after');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(api.decide_approval((select id from wf.approval_requests where entity_id = 'c4000000-0000-0000-0000-000000000001'), 'approve') ->> 'status',
  'approved', 'the escalation target decides the stage');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = 'c4000000-0000-0000-0000-000000000002'), 'approve')$$,
  'PERMISSION_DENIED%', 'a request that has not escalated stays with its approver');
select tests.clear_authentication();
select is((select count(*)::int from audit.audit_log where table_name = 'approval_escalations'), 4, 'escalations are audited');

select * from finish();
rollback;
