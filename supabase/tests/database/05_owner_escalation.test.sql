-- Owner lock-out safeguards and privilege-escalation prevention.
begin;
select tests.load_fixture();
select plan(14);
-- The owner guard is a DEFERRED constraint trigger (checked at commit); tests roll
-- back, so make constraints immediate to observe it inside the transaction.
set constraints all immediate;

select throws_like($$update authz.user_roles set revoked_at = now() where role_id = (select id from authz.roles where is_owner_role)$$,
  'LAST_OWNER%', 'cannot revoke the last owner');
select throws_like($$update core.user_profiles set status = 'suspended' where user_id = '00000000-0000-0000-0000-0000000000a1'$$,
  'LAST_OWNER%', 'cannot suspend the last owner');
select throws_like($$delete from authz.roles where is_owner_role$$, 'OWNER_ROLE_PROTECTED%', 'owner role cannot be deleted');
select throws_like($$update authz.roles set is_active = false where is_owner_role$$, 'OWNER_ROLE_PROTECTED%', 'owner role cannot be deactivated');
select lives_ok($$update authz.user_roles set revoked_at = now() where user_id = '00000000-0000-0000-0000-0000000000a5'$$,
  'revoking a non-owner role is not blocked by the owner guard');

-- Sales Director holds admin.role.assign with team scope
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select throws_like($$select api.grant_role('00000000-0000-0000-0000-0000000000a4', (select id from authz.roles where code = 'finance_officer'))$$,
  'ESCALATION_BLOCKED%', 'cannot grant a role with permissions the grantor does not hold');
select throws_like($$select api.grant_role('00000000-0000-0000-0000-0000000000a4', (select id from authz.roles where code = 'owner'))$$,
  'OWNER_ONLY%', 'non-owner cannot grant the owner role');
select throws_like($$select api.grant_role('00000000-0000-0000-0000-0000000000a2', (select id from authz.roles where code = 'sales_rep'))$$,
  'SELF_GRANT_FORBIDDEN%', 'users cannot grant roles to themselves');
select throws_like($$select api.grant_role('00000000-0000-0000-0000-0000000000a6', (select id from authz.roles where code = 'sales_rep'))$$,
  'PERMISSION_DENIED%', 'team-scoped assigner cannot manage users outside the team');
select isnt(api.grant_role('00000000-0000-0000-0000-0000000000a5', (select id from authz.roles where code = 'sales_rep'), null, 'rejoin'),
  null, 'can grant a role whose permissions the grantor holds, inside the team');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$insert into authz.user_roles (user_id, role_id) values ('00000000-0000-0000-0000-0000000000a4', (select id from authz.roles where code = 'owner'))$$,
  '%permission denied%', 'rep cannot insert role grants directly');

-- Owner hand-over: add a second owner, then the first may be removed
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select isnt(api.grant_role('00000000-0000-0000-0000-0000000000a7', (select id from authz.roles where code = 'owner'), null, 'second owner'),
  null, 'owner can appoint a second owner');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select lives_ok($$select api.revoke_role((select id from authz.user_roles where user_id = '00000000-0000-0000-0000-0000000000a1' and revoked_at is null), 'hand-over')$$,
  'with two owners, one owner role can be revoked');
select tests.clear_authentication();
select is(authz.count_active_owners(), 1, 'exactly one active owner remains');

select * from finish();
rollback;
