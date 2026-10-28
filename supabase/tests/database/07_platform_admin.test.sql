-- Platform administration commands: user context, registration, suspension,
-- role management with the grant ceiling, notifications, privileges.
begin;
select tests.load_fixture();
select plan(26);

-- my_context
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((api.my_context() #>> '{permissions,sales.discount.apply,limit}')::numeric, 3::numeric, 'rep context shows 3% discount limit');
select is(api.my_context() #>> '{permissions,sales.order.read,scope}', 'own', 'rep context shows own scope');
select ok(not (api.my_context() -> 'permissions' ? 'catalog.cost.read'), 'rep context has no cost permission');
select is(api.my_context() ->> 'is_owner', 'false', 'rep is not owner');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from jsonb_object_keys(api.my_context() -> 'permissions')),
          (select count(*)::int from authz.permissions), 'owner context includes every permission');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a9');
select is(api.my_context() ->> 'active', 'false', 'login without a profile is inactive');
select is(api.my_context() -> 'permissions', '{}'::jsonb, 'login without a profile has no permissions');

-- register_user (admin)
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select lives_ok($$select api.register_user('00000000-0000-0000-0000-0000000000a9', '20000000-0000-0000-0000-000000000009', 'ar')$$, 'admin links a login to an employee');
select throws_like($$select api.register_user('00000000-0000-0000-0000-0000000000a9', '20000000-0000-0000-0000-000000000004', 'ar')$$, 'CONFLICT%', 'an employee already linked to another login is protected');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a9');
select is(api.my_context() ->> 'active', 'true', 'registered user is active');
select is(api.my_context() -> 'permissions', '{}'::jsonb, 'registered user without roles still has no permissions');

-- suspension
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select lives_ok($$select api.suspend_user('00000000-0000-0000-0000-0000000000a4', 'left the company')$$, 'admin suspends a rep');
select throws_like($$select api.suspend_user('00000000-0000-0000-0000-0000000000a7', 'x')$$, 'SELF_SUSPEND_FORBIDDEN%', 'nobody suspends themselves');
select throws_like($$select api.suspend_user('00000000-0000-0000-0000-0000000000a1', 'x')$$, 'OWNER_ONLY%', 'admin cannot suspend an owner');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.my_context() ->> 'active', 'false', 'suspended rep is inactive on the next request');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select lives_ok($$select api.reactivate_user('00000000-0000-0000-0000-0000000000a4', 'rehired')$$, 'admin reactivates the rep');

-- role management and the ceiling
select lives_ok($$select api.set_role_permission((select id from authz.roles where code = 'sales_rep'), 'core.employee.read', 'own')$$,
  'admin grants a permission it holds');
select throws_like($$select api.set_role_permission((select id from authz.roles where code = 'sales_rep'), 'sales.discount.apply', 'own', 50)$$,
  'ESCALATION_BLOCKED%', 'admin cannot grant money permissions it does not hold');
select throws_like($$select api.set_role_permission((select id from authz.roles where code = 'owner'), 'crm.customer.read', 'all')$$,
  'OWNER_ROLE_PROTECTED%', 'owner role permissions cannot be edited');
select throws_like($$select api.set_role_permission((select id from authz.roles where code = 'sales_rep'), 'crm.customer.read', 'own', 5)$$,
  'VALIDATION%', 'limits are rejected on permissions without limits');
select throws_like($$select api.create_role('Bad Code', 'Bad')$$, 'VALIDATION%', 'role codes are validated');
select isnt(api.create_role('key_account_rep', 'Key Account Rep'), null, 'admin creates a custom role');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$select api.set_role_permission((select id from authz.roles where code = 'sales_rep'), 'sales.discount.apply', 'own', 5)$$,
  'owner raises the rep discount limit');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((api.my_context() #>> '{permissions,sales.discount.apply,limit}')::numeric, 5::numeric, 'rep sees the new limit immediately');

-- notifications: only own rows are marked read
select tests.clear_authentication();
insert into notify.notifications (id, recipient_user_id, type, title) values
  ('a0000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a4','test','mine'),
  ('a0000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000a5','test','not mine');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.mark_notifications_read(array['a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002']::uuid[]),
  1, 'a user can only mark their own notifications read');
select tests.clear_authentication();

-- bootstrap is a one-time operation
select throws_like($$select core.bootstrap_owner('owner@honest.test', 'Owner')$$, 'BOOTSTRAP_DONE%', 'owner bootstrap refuses when an owner exists');

select * from finish();
rollback;
