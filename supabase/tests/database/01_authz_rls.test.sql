-- Row-level visibility per role, status gates, overrides, expiry.
begin;
select tests.load_fixture();
select plan(18);

-- Sales rep (Cairo, Nasr City)
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from crm.customers), 1, 'rep sees only own assigned customer');
select is((select customer_no from crm.customers limit 1), 'C-0001', 'rep sees C-0001');
select is((select count(*)::int from catalog.product_costs), 0, 'rep cannot see purchase costs');
select is((select count(*)::int from catalog.price_list_items), 1, 'rep can see selling prices');
select is((select count(*)::int from api.v_users), 1, 'rep sees only own profile in the users view');

-- Area manager (Cairo & Giza region, incl. sub-areas)
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from crm.customers where customer_no = 'C-0001'), 1, 'area manager sees customer in a sub-territory');
select is((select count(*)::int from crm.customers where customer_no = 'C-0002'), 0, 'area manager does not see Delta');

-- Finance (all) and Sales Director (all)
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select count(*)::int from crm.customers), 2, 'finance sees all customers');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from crm.customers), 2, 'sales director sees all customers');

-- Roles without CRM permissions
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is((select count(*)::int from crm.customers), 0, 'IT admin has no customer access by default');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is((select count(*)::int from crm.customers), 0, 'inventory manager has no customer access');

-- Unknown user and anonymous requests
select tests.authenticate_as('00000000-0000-0000-0000-00000000ffff');
select is((select count(*)::int from crm.customers), 0, 'unknown user sees nothing (deny by default)');
select tests.authenticate_anon();
select throws_like('select count(*) from crm.customers', '%permission denied%', 'anon cannot touch domain schemas');
select tests.clear_authentication();

-- Status gates: suspension and termination take effect immediately
update core.user_profiles set status = 'suspended' where user_id = '00000000-0000-0000-0000-0000000000a4';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from crm.customers), 0, 'suspended user sees nothing');
select tests.clear_authentication();
update core.employees set employment_status = 'terminated' where id = '20000000-0000-0000-0000-000000000005';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from crm.customers), 0, 'terminated employee sees nothing');
select tests.clear_authentication();

-- DENY override beats a role grant
insert into authz.user_permission_overrides (user_id, permission_code, effect, reason)
values ('00000000-0000-0000-0000-0000000000a6', 'crm.customer.read', 'deny', 'test');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select count(*)::int from crm.customers), 0, 'deny override beats role grant');
select tests.clear_authentication();

-- Expired role assignment grants nothing
update authz.user_roles set valid_to = now() - interval '1 minute'
where user_id = '00000000-0000-0000-0000-0000000000a2';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from crm.customers), 0, 'expired role grants nothing');
select tests.clear_authentication();

-- Expiring GRANT override works only while valid
insert into authz.user_permission_overrides (user_id, permission_code, effect, scope, reason, expires_at)
values ('00000000-0000-0000-0000-0000000000a8', 'crm.customer.read', 'grant', 'all', 'audit support', now() + interval '1 day');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is((select count(*)::int from crm.customers), 2, 'time-bound grant override applies');

select * from finish();
rollback;
