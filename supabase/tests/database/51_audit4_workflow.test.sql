-- Audit 4 (access), workflow: A-M4 auto-approve rules are owner-only end to end, and A-L1
-- escalation authority is re-checked when the target decides.
-- Fixture users: a1 owner · a2 sales director (manager of a3) · a3 area manager (manager of a4)
--                a4 rep Cairo · a6 finance · a7 admin (admin.workflow.manage, not an owner) · a8 inventory
begin;
select tests.load_fixture();
select plan(42);

-- ---------------------------------------------------------------------------
-- A-M4 setup: test.am4 (created here, not seeded)
--   priority 20  pct <= 5   stage: user a2         (admin rule, checked BEFORE the owner's auto rule)
--   priority 30  pct <= 1   auto-approve           (created by the owner below)
--   priority 50  pct <= 50  stage: user a2         (admin rule, checked AFTER the auto rule)
--   priority 100 {}         stage: user a2         (catch-all)
-- ---------------------------------------------------------------------------
insert into wf.workflow_definitions (id, code, name, entity_type) values
  ('c1000000-0000-0000-0000-0000000004a1', 'test.am4', 'Test auto-approve guard', 'test');
insert into wf.workflow_rules (id, definition_id, priority, condition) values
  ('c2000000-0000-0000-0000-0000000004a1', 'c1000000-0000-0000-0000-0000000004a1', 100, '{}'),
  ('c2000000-0000-0000-0000-0000000004a2', 'c1000000-0000-0000-0000-0000000004a1', 20,
   '{"all":[{"field":"pct","op":"<=","value":5}]}'),
  ('c2000000-0000-0000-0000-0000000004a3', 'c1000000-0000-0000-0000-0000000004a1', 50,
   '{"all":[{"field":"pct","op":"<=","value":50}]}');
insert into wf.workflow_stages (rule_id, stage_no, approver_type, approver_user_id) values
  ('c2000000-0000-0000-0000-0000000004a1', 1, 'user', '00000000-0000-0000-0000-0000000000a2'),
  ('c2000000-0000-0000-0000-0000000004a2', 1, 'user', '00000000-0000-0000-0000-0000000000a2'),
  ('c2000000-0000-0000-0000-0000000004a3', 1, 'user', '00000000-0000-0000-0000-0000000000a2');

create temp table t_auto (id uuid) on commit drop;
grant all on t_auto to authenticated;

-- The owner adds a narrow auto-approve rule (legitimate).
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
insert into t_auto select (api.upsert_workflow_rule('test.am4', 30, '{"all":[{"field":"pct","op":"<=","value":1}]}',
  true, null, null, 'owner: tiny discounts') ->> 'rule_id')::uuid;
select is((select count(*)::int from t_auto where id is not null), 1, 'an owner creates an auto-approve rule');

-- Attacks by the admin (a7): every one is refused.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select throws_like(format($$select api.upsert_workflow_rule('test.am4', 1, '{}', true, %L, null, 'widen')$$, (select id from t_auto)),
  'OWNER_ONLY%', 'A-M4 repro: an admin cannot widen the owner''s auto rule to {} at priority 1');
select throws_like(format($$select api.upsert_workflow_rule('test.am4', 31, '{"all":[{"field":"pct","op":"<=","value":1}]}', true, %L, null, 'move')$$,
  (select id from t_auto)), 'OWNER_ONLY%', 'an admin cannot change the priority of an auto rule');
select throws_like(format($$select api.upsert_workflow_rule('test.am4', 30, '{"all":[{"field":"pct","op":"<=","value":90}]}', true, %L, null, 'widen')$$,
  (select id from t_auto)), 'OWNER_ONLY%', 'an admin cannot change the condition of an auto rule');
select throws_like(format($$select api.upsert_workflow_rule('test.am4', 30, '{"all":[{"field":"pct","op":"<=","value":1}]}', false, %L, null, 'off')$$,
  (select id from t_auto)), 'OWNER_ONLY%', 'an admin cannot switch an owner''s auto rule off either');
select throws_like(format($$select api.set_workflow_stage(%L, 1, 'user', null, null, '00000000-0000-0000-0000-0000000000a2', 1, null, null, false, 'stage')$$,
  (select id from t_auto)), 'OWNER_ONLY%', 'an admin cannot set a stage on an auto rule');
select throws_like($$select api.upsert_workflow_rule('test.am4', 40, '{"all":[{"field":"pct","op":"<=","value":5}]}', false,
  'c2000000-0000-0000-0000-0000000004a2', null, 'move behind')$$,
  'OWNER_ONLY%', 'an admin cannot move a rule from before an auto rule to after it (the auto rule would win)');
select throws_like($$select api.upsert_workflow_rule('test.am4', 20, '{"all":[{"field":"pct","op":"<=","value":0}]}', false,
  'c2000000-0000-0000-0000-0000000004a2', null, 'narrow')$$,
  'OWNER_ONLY%', 'an admin cannot change the condition of a rule checked before an auto rule');
select throws_like($$select api.upsert_workflow_rule('test.am4', 20, '{"all":[{"field":"pct","op":"<=","value":6}]}', false,
  'c2000000-0000-0000-0000-0000000004a2', null, 'broaden')$$,
  'OWNER_ONLY%', 'any condition change of a rule checked before an auto rule is owner-only (even a broader one)');
select is((api.upsert_workflow_rule('test.am4', 19, '{"all":[{"field":"pct","op":"<=","value":5}]}', false,
  'c2000000-0000-0000-0000-0000000004a2', null, 'check earlier')) ->> 'created', 'false',
  'moving such a rule further ahead with the same condition is allowed (it cannot expose the auto rule)');
select tests.clear_authentication();

select is((select r.auto_approve from wf.workflow_rules r
           where r.id = wf.resolve_rule('c1000000-0000-0000-0000-0000000004a1', '{"pct": 60}'::jsonb)), false,
  'after the attempts a 60 % request still needs approval');
select is((select r.priority from wf.workflow_rules r
           where r.id = wf.resolve_rule('c1000000-0000-0000-0000-0000000004a1', '{"pct": 3}'::jsonb)), 19,
  'a 3 % request still stops at the admin rule ahead of the auto rule');
select is((select r.condition from wf.workflow_rules r join t_auto a on a.id = r.id),
  '{"all":[{"field":"pct","op":"<=","value":1}]}'::jsonb, 'the auto rule is unchanged');

-- Legitimate admin changes still work: rules that are not auto and do not shadow one.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is((api.upsert_workflow_rule('test.am4', 60, '{"all":[{"field":"pct","op":"<=","value":40}]}', false,
  'c2000000-0000-0000-0000-0000000004a3', null, 'tighten')) ->> 'created', 'false',
  'an admin edits a non-auto rule that is checked after the auto rule');
select is((api.upsert_workflow_rule('test.am4', 25, '{"all":[{"field":"pct","op":"<=","value":40}]}', false,
  'c2000000-0000-0000-0000-0000000004a3', null, 'check earlier')) ->> 'created', 'false',
  'an admin moves a non-auto rule ahead of the auto rule (it can only take requests away from it)');
select is((api.upsert_workflow_rule('test.am4', 10, '{"all":[{"field":"pct","op":">","value":80}]}', false, null,
  '[{"approver_type":"user","approver_user_id":"00000000-0000-0000-0000-0000000000a2"}]', 'large')) ->> 'created', 'true',
  'an admin creates a new non-auto rule');
select ok((api.set_workflow_stage('c2000000-0000-0000-0000-0000000004a1', 1, 'user', null, null,
  '00000000-0000-0000-0000-0000000000a3', 1, null, null, false, 'area manager')) ->> 'stage_id' is not null,
  'an admin sets a stage on a non-auto rule');
select tests.clear_authentication();

-- The owner may change everything.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((api.upsert_workflow_rule('test.am4', 15, '{"all":[{"field":"pct","op":"<=","value":2}]}', true,
  (select id from t_auto), null, 'owner widens slightly')) ->> 'created', 'false', 'an owner edits an auto rule');
select is((api.upsert_workflow_rule('test.am4', 22, '{"all":[{"field":"pct","op":"<=","value":4}]}', false,
  'c2000000-0000-0000-0000-0000000004a2', null, 'owner reorders')) ->> 'created', 'false',
  'an owner edits a rule around an auto rule');
select ok((api.set_workflow_stage((select id from t_auto), 1, 'user', null, null,
  '00000000-0000-0000-0000-0000000000a2', 1, null, null, false, 'owner prepares a stage')) ->> 'stage_id' is not null,
  'an owner sets a stage on an auto rule');
select is((api.upsert_workflow_rule('test.am4', 15, '{"all":[{"field":"pct","op":"<=","value":2}]}', false,
  (select id from t_auto), null, 'owner switches it off')) ->> 'created', 'false', 'an owner switches auto-approve off');
select tests.clear_authentication();

-- Once no auto rule is left, the admin edits the former shadowing rule again.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is((api.upsert_workflow_rule('test.am4', 45, '{"all":[{"field":"pct","op":"<=","value":4}]}', false,
  'c2000000-0000-0000-0000-0000000004a2', null, 'free again')) ->> 'created', 'false',
  'without an auto rule behind it, a rule is the admin''s to edit');
select tests.clear_authentication();

-- ---------------------------------------------------------------------------
-- A-L1 setup (escalation)
--   test.l1u  stage 1 user a3, 60 min, no fallback         → level 1 = a3's manager a2
--   test.l1f  stage 1 user a3, 60 min, fallback a6          → level 1 = a6
--   test.l1p  stage 1 permission wf.decide.test_esc_limit, 60 min, fallback a8 (holds nothing of it)
--   test.l1r  stage 1 role inventory_manager, 60 min        → level 1 = owners
-- Requests are created by a4 and back-dated 90 minutes.
-- ---------------------------------------------------------------------------
insert into authz.permissions (code, module, description, supports_limit)
values ('wf.decide.test_esc_limit', 'wf', 'test-only approval permission with a limit', true);
insert into wf.workflow_definitions (id, code, name, entity_type) values
  ('c1000000-0000-0000-0000-0000000001a1', 'test.l1u', 'Test escalation user', 'test'),
  ('c1000000-0000-0000-0000-0000000001a2', 'test.l1f', 'Test escalation fallback', 'test'),
  ('c1000000-0000-0000-0000-0000000001a3', 'test.l1p', 'Test escalation permission', 'test'),
  ('c1000000-0000-0000-0000-0000000001a4', 'test.l1r', 'Test escalation role', 'test');
insert into wf.workflow_rules (id, definition_id, priority, condition) values
  ('c2000000-0000-0000-0000-0000000001a1', 'c1000000-0000-0000-0000-0000000001a1', 100, '{}'),
  ('c2000000-0000-0000-0000-0000000001a2', 'c1000000-0000-0000-0000-0000000001a2', 100, '{}'),
  ('c2000000-0000-0000-0000-0000000001a3', 'c1000000-0000-0000-0000-0000000001a3', 100, '{}'),
  ('c2000000-0000-0000-0000-0000000001a4', 'c1000000-0000-0000-0000-0000000001a4', 100, '{}');
insert into wf.workflow_stages (rule_id, stage_no, approver_type, approver_permission, approver_role_id, approver_user_id,
                                escalate_after, escalate_to_user_id) values
  ('c2000000-0000-0000-0000-0000000001a1', 1, 'user', null, null, '00000000-0000-0000-0000-0000000000a3', interval '60 minutes', null),
  ('c2000000-0000-0000-0000-0000000001a2', 1, 'user', null, null, '00000000-0000-0000-0000-0000000000a3', interval '60 minutes',
   '00000000-0000-0000-0000-0000000000a6'),
  ('c2000000-0000-0000-0000-0000000001a3', 1, 'permission', 'wf.decide.test_esc_limit', null, null, interval '60 minutes',
   '00000000-0000-0000-0000-0000000000a8'),
  ('c2000000-0000-0000-0000-0000000001a4', 1, 'role', null, (select id from authz.roles where code = 'inventory_manager'), null,
   interval '60 minutes', null);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a4', true);
select wf.create_request('test.l1u', 'test', 'c4000000-0000-0000-0000-0000000001b1', '{}');
select wf.create_request('test.l1u', 'test', 'c4000000-0000-0000-0000-0000000001b2', '{}');
select wf.create_request('test.l1f', 'test', 'c4000000-0000-0000-0000-0000000001b3', '{}');
select wf.create_request('test.l1p', 'test', 'c4000000-0000-0000-0000-0000000001b4', '{"limit_metric": 500}');
select wf.create_request('test.l1p', 'test', 'c4000000-0000-0000-0000-0000000001b5', '{"limit_metric": 50}');
select wf.create_request('test.l1r', 'test', 'c4000000-0000-0000-0000-0000000001b6', '{}');
select set_config('request.jwt.claim.sub', '', true);
update wf.approval_requests set created_at = now() - interval '90 minutes' where entity_id::text like 'c4000000-0000-0000-0000-0000000001b%';

create temp table t_req (k text primary key, id uuid) on commit drop;
grant all on t_req to authenticated;
insert into t_req select 'u1', id from wf.approval_requests where entity_id = 'c4000000-0000-0000-0000-0000000001b1';
insert into t_req select 'u2', id from wf.approval_requests where entity_id = 'c4000000-0000-0000-0000-0000000001b2';
insert into t_req select 'f',  id from wf.approval_requests where entity_id = 'c4000000-0000-0000-0000-0000000001b3';
insert into t_req select 'p500', id from wf.approval_requests where entity_id = 'c4000000-0000-0000-0000-0000000001b4';
insert into t_req select 'p50',  id from wf.approval_requests where entity_id = 'c4000000-0000-0000-0000-0000000001b5';
insert into t_req select 'r',  id from wf.approval_requests where entity_id = 'c4000000-0000-0000-0000-0000000001b6';

select is(service.workflow_escalate() ->> 'escalated', '6', 'every back-dated request escalates once');
select is((select basis || ':' || array_to_string(target_user_ids, ',') from wf.approval_escalations e join t_req t on t.id = e.request_id
           where t.k = 'u1'), 'approver_manager:00000000-0000-0000-0000-0000000000a2', 'the user stage escalates to a3''s manager a2');
select is((select basis from wf.approval_escalations e join t_req t on t.id = e.request_id where t.k = 'r'), 'owners',
  'the role stage escalates to the owners');

-- Legitimate: an eligible target (still a2's manager role and wf.approval.read) decides.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(authz.approval_verdict((select id from t_req where k = 'u1')), 'ok', 'an eligible escalation target may decide');
select is(api.decide_approval((select id from t_req where k = 'u1'), 'approve') ->> 'status', 'approved',
  'an eligible escalation target decides the stage');
select tests.clear_authentication();

-- A-L1 repro: the target is demoted (every role revoked; still an active user, still a3's manager).
update authz.user_roles set revoked_at = now() where user_id = '00000000-0000-0000-0000-0000000000a2' and revoked_at is null;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(authz.approval_verdict((select id from t_req where k = 'u2')), 'not_approver', 'a demoted target loses the escalated decision');
select throws_like(format($$select api.decide_approval(%L, 'approve')$$, (select id from t_req where k = 'u2')),
  'PERMISSION_DENIED%', 'A-L1 repro: decide_approval refuses the demoted target');
select tests.clear_authentication();
update authz.user_roles set revoked_at = null
where user_id = '00000000-0000-0000-0000-0000000000a2' and revoked_at is not null;

-- The target leaves the approver's management chain (a3 now reports to the owner directly).
update core.employees set manager_id = '20000000-0000-0000-0000-000000000001' where id = '20000000-0000-0000-0000-000000000003';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(authz.approval_verdict((select id from t_req where k = 'u2')), 'not_approver',
  'a target no longer above the approver loses the escalated decision');
select tests.clear_authentication();
update core.employees set manager_id = '20000000-0000-0000-0000-000000000002' where id = '20000000-0000-0000-0000-000000000003';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(authz.approval_verdict((select id from t_req where k = 'u2')), 'ok', 'back in the chain, the target may decide again');
select tests.clear_authentication();

-- Inactive target: decided by nobody through the escalation.
update core.user_profiles set status = 'suspended' where user_id = '00000000-0000-0000-0000-0000000000a2';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select throws_like(format($$select api.decide_approval(%L, 'approve')$$, (select id from t_req where k = 'u2')),
  'PERMISSION_DENIED%', 'an inactive target cannot decide');
select tests.clear_authentication();
update core.user_profiles set status = 'active' where user_id = '00000000-0000-0000-0000-0000000000a2';

-- Configured fallback: decides while it is still the stage's fallback, not after it is replaced.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(authz.approval_verdict((select id from t_req where k = 'f')), 'ok', 'the configured fallback may decide');
select tests.clear_authentication();
update wf.workflow_stages set escalate_to_user_id = '00000000-0000-0000-0000-0000000000a8'
where rule_id = 'c2000000-0000-0000-0000-0000000001a2';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(authz.approval_verdict((select id from t_req where k = 'f')), 'not_approver',
  'a replaced fallback loses the escalated decision');
select tests.clear_authentication();
update wf.workflow_stages set escalate_to_user_id = '00000000-0000-0000-0000-0000000000a6'
where rule_id = 'c2000000-0000-0000-0000-0000000001a2';

-- Permission stage: the fallback needs the stage permission, in scope, within its limit.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_like(format($$select api.decide_approval(%L, 'approve')$$, (select id from t_req where k = 'p50')),
  'PERMISSION_DENIED%', 'a fallback without the stage permission cannot decide a permission stage');
select tests.clear_authentication();
insert into authz.user_permission_overrides (user_id, permission_code, effect, scope, limit_value, reason)
values ('00000000-0000-0000-0000-0000000000a8', 'wf.decide.test_esc_limit', 'grant', 'all', 100, 'test approver up to 100');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(authz.approval_verdict((select id from t_req where k = 'p500')), 'limit', 'the escalation is bounded by the target''s limit');
select throws_like(format($$select api.decide_approval(%L, 'approve')$$, (select id from t_req where k = 'p500')),
  'LIMIT_EXCEEDED%', 'decide_approval applies the limit to an escalation target');
select is(api.decide_approval((select id from t_req where k = 'p50'), 'approve') ->> 'status', 'approved',
  'within its limit the fallback decides');
select tests.clear_authentication();

-- Role stage escalated to the owners: the owner decides, but not once their owner role is gone.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(authz.approval_verdict((select id from t_req where k = 'r')), 'ok', 'an owner reached by escalation may decide a role stage');
select tests.clear_authentication();
-- Requester and subject stay excluded even if an escalation names them.
insert into wf.approval_escalations (request_id, stage_no, level, target_user_ids, basis)
select id, 1, 2, array['00000000-0000-0000-0000-0000000000a4']::uuid[], 'approver_manager' from t_req where k = 'r';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like(format($$select api.decide_approval(%L, 'approve')$$, (select id from t_req where k = 'r')),
  'SELF_APPROVAL%', 'the requester cannot decide even when an escalation names them');
select tests.clear_authentication();
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.decide_approval((select id from t_req where k = 'r'), 'approve') ->> 'status', 'approved',
  'the owner decides the escalated role stage');
select tests.clear_authentication();

-- Privileges: the new helper is internal.
select ok(not has_function_privilege('authenticated', 'wf.escalation_target_check(uuid, uuid, uuid)', 'execute')
          and not has_function_privilege('anon', 'wf.escalation_target_check(uuid, uuid, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'wf.rule_change_exposes_auto(uuid, int, jsonb)', 'execute')
          and not has_function_privilege('anon', 'wf.rule_change_exposes_auto(uuid, int, jsonb)', 'execute'),
  'the new workflow helpers are not client-callable');

select * from finish();
rollback;
