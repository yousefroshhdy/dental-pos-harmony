-- Audit 4, area A (20261104000500_audit4_owner_guards.sql):
--   A-M2  the deferred employment guard runs at commit as `authenticated`: it must be a definer
--         function, or every suspend / terminate fails at commit
--   A-M3  one "effective owner" predicate (profile active, employment active/on_leave, owner role
--         active and valid) in every last-owner guard, plus one advisory lock on the owner set
--   A-M1  employment deactivation/reactivation needs the admin.user.suspend step-up; manager,
--         department, territory-assignment and territory-tree changes need the admin.role.assign
--         step-up (only while security.mfa_enforced is on)
--   users: a1 owner · a4 rep Cairo · a7 admin · b1 a second (synthetic) owner
--
-- Constraints stay DEFERRED here (the default), as in production. pg_temp.fire / pg_temp.probe
-- fire the deferred triggers with `set constraints all immediate` while the CALLER's role is
-- active, which is what happens at a real COMMIT (a7 / a1 are `authenticated` then).
begin;
select tests.load_fixture();
select plan(54);

-- Runs a statement, then fires every pending deferred trigger as the current role.
-- Returns 'OK' or 'ERROR <sqlstate> <CODE>'. On error nothing of it remains (subtransaction).
create function pg_temp.fire(p_sql text) returns text language plpgsql as $$
begin
  if p_sql is not null then execute p_sql; end if;
  set constraints all immediate;
  set constraints all deferred;
  return 'OK';
exception when others then
  return 'ERROR ' || sqlstate || ' ' || split_part(sqlerrm, ':', 1);
end $$;
-- Same, but always rolls the statement back: "would this be allowed (including at commit)?"
create function pg_temp.probe(p_sql text) returns text language plpgsql as $$
begin
  begin
    execute p_sql;
    set constraints all immediate;
    raise exception 'PROBE_OK' using errcode = 'P0001';
  exception when others then
    if sqlerrm = 'PROBE_OK' then return 'OK'; end if;
    return 'ERROR ' || sqlstate || ' ' || split_part(sqlerrm, ':', 1);
  end;
end $$;
grant execute on function pg_temp.fire(text) to authenticated;
grant execute on function pg_temp.probe(text) to authenticated;

create function pg_temp.enforce(p_on boolean) returns void language sql as $$
  update core.system_settings set value = to_jsonb(p_on) where key = 'security.mfa_enforced'
$$;
-- A's (the fixture owner's) owner-role assignment.
create function pg_temp.owner_ur() returns uuid language sql stable as $$
  select ur.id from authz.user_roles ur join authz.roles r on r.id = ur.role_id and r.is_owner_role
  where ur.user_id = '00000000-0000-0000-0000-0000000000a1'
$$;
grant execute on function pg_temp.owner_ur() to authenticated;
-- The owner-set advisory lock is held by this backend.
create function pg_temp.owner_lock_held() returns boolean language sql as $$
  select exists (select 1 from pg_locks l
                 where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted
                   and l.classid::bigint = (hashtextextended('authz.owner_set', 0) >> 32) & 4294967295
                   and l.objid::bigint   =  hashtextextended('authz.owner_set', 0) & 4294967295)
$$;

-- ===========================================================================
-- 0. Shape and privileges
-- ===========================================================================
select ok((select prosecdef from pg_proc where oid = 'core.guard_last_owner_employment()'::regprocedure),
  'A-M2: the employment last-owner guard is SECURITY DEFINER');
select is((select count(*)::int from pg_proc p
           where p.oid in ('core.guard_last_owner_employment()'::regprocedure, 'authz.guard_last_owner()'::regprocedure,
                           'authz.is_effective_owner(uuid)'::regprocedure, 'authz.count_active_owners()'::regprocedure,
                           'authz.lock_owner_set()'::regprocedure)
             and p.proconfig @> array['search_path=""']
             and not has_function_privilege('authenticated', p.oid, 'execute')
             and not has_function_privilege('anon', p.oid, 'execute')
             and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')),
  5, 'the guards and owner helpers pin search_path and are not client-callable');
select ok((select bool_and(p.prosecdef) from pg_proc p
           where p.oid in ('api.set_employment_status(uuid, text, text, date)'::regprocedure,
                           'api.update_employee(uuid, text, text, text, text, text, uuid, uuid, uuid, date, timestamptz)'::regprocedure,
                           'api.assign_employee_territory(uuid, uuid, text)'::regprocedure,
                           'api.end_employee_territory(uuid, text)'::regprocedure,
                           'api.move_territory(uuid, uuid, text)'::regprocedure)
             and has_function_privilege('authenticated', p.oid, 'execute')
             and not has_function_privilege('anon', p.oid, 'execute')),
  'the redefined commands stay definer, open to authenticated and closed to anon');
select ok(exists (select 1 from pg_trigger where tgname = 'trg_profiles_last_owner_link'
                  and tgrelid = 'core.user_profiles'::regclass and tgdeferrable and tginitdeferred),
  'a deferred last-owner guard watches profile re-links too');

-- ===========================================================================
-- 1. A-M2: deactivating an employee survives the commit-time guard (as authenticated)
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is(api.set_employment_status('20000000-0000-0000-0000-000000000004', 'suspended', 'synthetic') ->> 'status',
  'suspended', 'the admin suspends a rep');
select is(pg_temp.fire(null), 'OK', 'A-M2: the deferred guard fires as authenticated without a permission error');
select is(pg_temp.probe($$select api.set_employment_status('20000000-0000-0000-0000-000000000005', 'terminated', 'left')$$),
  'OK', 'A-M2: terminating a rep commits too');
select tests.clear_authentication();
select is((select employment_status from core.employees where id = '20000000-0000-0000-0000-000000000004'),
  'suspended', 'and the suspension is stored');
select ok(pg_temp.owner_lock_held(), 'A-M3: an employment status change takes the owner-set lock');

-- ===========================================================================
-- 2. A-M3: one effective-owner predicate in every guard
-- ===========================================================================
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000b1', 'owner2@honest.test');
insert into core.employees (id, employee_no, user_id, full_name_en, job_title)
  values ('20000000-0000-0000-0000-0000000000b1', 'E0B1', '00000000-0000-0000-0000-0000000000b1', 'Owner Two', 'Co-owner');
insert into core.user_profiles (user_id, employee_id)
  values ('00000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000b1');
insert into authz.user_roles (id, user_id, role_id)
  select '30000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1', id from authz.roles where code = 'owner';
-- A suspended employee record nobody signs in with (for the re-link case).
insert into core.employees (id, employee_no, full_name_en, job_title, employment_status)
  values ('20000000-0000-0000-0000-0000000000c1', 'E0C1', 'Former Staff', 'Clerk', 'suspended');
select is(pg_temp.fire(null), 'OK', 'setup: a second owner');
select is(authz.count_active_owners(), 2, 'two effective owners');

-- The auditor's scenario: A terminates B, then A revokes A's own owner role.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(pg_temp.fire($$select api.set_employment_status('20000000-0000-0000-0000-0000000000b1', 'terminated', 'synthetic')$$),
  'OK', 'owner A may terminate owner B while A remains an effective owner');
select tests.clear_authentication();
select is(authz.count_active_owners(), 1, 'A-M3: the terminated owner is no longer counted');
select ok(authz.is_effective_owner('00000000-0000-0000-0000-0000000000a1'), 'A is an effective owner');
select ok(not authz.is_effective_owner('00000000-0000-0000-0000-0000000000b1'), 'B (terminated) is not');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(pg_temp.probe($$select api.revoke_role((select pg_temp.owner_ur()), 'synthetic')$$),
  'ERROR P0001 LAST_OWNER', 'A-M3: A cannot then revoke A''s own owner role (B is terminated)');
select is((api.my_context() ->> 'is_owner')::boolean, true, 'A is still the owner');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000b1');
select is((api.my_context() ->> 'is_owner')::boolean, false, 'B (terminated) is not, matching authz.is_owner');
select tests.clear_authentication();
select is(pg_temp.probe($$update core.user_profiles set status = 'suspended' where user_id = '00000000-0000-0000-0000-0000000000a1'$$),
  'ERROR P0001 LAST_OWNER', 'A-M3: nor can A''s profile be suspended');
select is(pg_temp.probe($$update core.employees set employment_status = 'suspended' where id = '20000000-0000-0000-0000-000000000001'$$),
  'ERROR P0001 LAST_OWNER', 'nor A''s employment be suspended');
select is(pg_temp.probe($$update core.user_profiles set employee_id = '20000000-0000-0000-0000-0000000000c1'
                          where user_id = '00000000-0000-0000-0000-0000000000a1'$$),
  'ERROR P0001 LAST_OWNER', 'nor A''s profile be re-linked to a suspended employee record');
select is(pg_temp.probe($$update authz.user_roles set valid_from = now() + interval '1 day' where id = (select pg_temp.owner_ur())$$),
  'ERROR P0001 LAST_OWNER', 'nor A''s owner role be postponed (valid_from in the future)');

-- B back to work: then B's other states count as they do for authz.is_owner.
update core.employees set employment_status = 'active', terminated_on = null where id = '20000000-0000-0000-0000-0000000000b1';
select is(authz.count_active_owners(), 2, 'B reinstated: two effective owners again');
select is(pg_temp.probe($$update core.employees set employment_status = 'on_leave' where id = '20000000-0000-0000-0000-0000000000b1';
                          update authz.user_roles set revoked_at = now() where id = (select pg_temp.owner_ur())$$),
  'OK', 'an owner on leave is still an effective owner (A may hand over to B on leave)');
update authz.user_roles set valid_from = now() + interval '1 day' where id = '30000000-0000-0000-0000-0000000000b1';
select is(authz.count_active_owners(), 1, 'an owner role that starts tomorrow is not counted today');
select is(pg_temp.probe($$update authz.user_roles set revoked_at = now() where id = (select pg_temp.owner_ur())$$),
  'ERROR P0001 LAST_OWNER', 'so A cannot hand over to B yet');
update authz.user_roles set valid_from = now() - interval '1 minute' where id = '30000000-0000-0000-0000-0000000000b1';
update core.user_profiles set status = 'suspended' where user_id = '00000000-0000-0000-0000-0000000000b1';
select is(pg_temp.probe($$update authz.user_roles set revoked_at = now() where id = (select pg_temp.owner_ur())$$),
  'ERROR P0001 LAST_OWNER', 'nor while B''s profile is suspended');
update core.user_profiles set status = 'active' where user_id = '00000000-0000-0000-0000-0000000000b1';
select is(pg_temp.probe($$update authz.user_roles set revoked_at = now() where id = (select pg_temp.owner_ur())$$),
  'OK', 'with B fully effective, A may hand over');
select is(pg_temp.fire(null), 'OK', 'setup: B is an effective owner again');

-- The predicate matches authz.is_owner for every fixture user.
create temp table owner_check (user_id uuid primary key, ctx boolean);
grant all on owner_check to authenticated;
do $$
declare u uuid;
begin
  foreach u in array array['00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a4',
                           '00000000-0000-0000-0000-0000000000a7','00000000-0000-0000-0000-0000000000b1']::uuid[] loop
    perform tests.authenticate_as(u);
    insert into owner_check values (u, (api.my_context() ->> 'is_owner')::boolean);
    perform tests.clear_authentication();
  end loop;
end $$;
select is((select count(*)::int from owner_check where ctx is distinct from authz.is_effective_owner(user_id)), 0,
  'authz.is_effective_owner(u) agrees with authz.is_owner() as u');

-- ===========================================================================
-- 3. A-M1: MFA step-up on employment, reporting and territory changes
-- ===========================================================================
insert into core.departments (id, code, name_en, name_ar) values
  ('21000000-0000-0000-0000-000000000001', 'SALES', 'Sales', 'المبيعات');
select ok((select bool_and(requires_mfa) from authz.permissions where code in ('admin.user.suspend', 'admin.role.assign')),
  'the gates reuse the admin.user.suspend and admin.role.assign flags');
select pg_temp.enforce(true);

-- 3a. Employment status: deactivation and reactivation
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is(pg_temp.probe($$select api.set_employment_status('20000000-0000-0000-0000-000000000005', 'suspended', 'x')$$),
  'ERROR 42501 MFA_REQUIRED', 'enforced, aal1: deactivating an employee needs step-up');
select is(pg_temp.probe($$select api.set_employment_status('20000000-0000-0000-0000-000000000004', 'active', 'back')$$),
  'ERROR 42501 MFA_REQUIRED', 'enforced, aal1: reactivating an employee needs step-up');
select is(pg_temp.probe($$select api.set_employment_status('20000000-0000-0000-0000-000000000005', 'on_leave', 'holiday')$$),
  'OK', 'enforced, aal1: active ↔ on_leave changes no access and needs no step-up');
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a7');
select is(pg_temp.probe($$select api.set_employment_status('20000000-0000-0000-0000-000000000005', 'suspended', 'x')$$),
  'OK', 'enforced, aal2: deactivation is allowed');
select is(pg_temp.probe($$select api.set_employment_status('20000000-0000-0000-0000-000000000004', 'active', 'back')$$),
  'OK', 'enforced, aal2: reactivation is allowed');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is(pg_temp.probe($$select api.set_employment_status('20000000-0000-0000-0000-000000000004', 'active', 'x')$$),
  'ERROR 42501 PERMISSION_DENIED', 'a non-holder still sees PERMISSION_DENIED, never MFA_REQUIRED');

-- 3b. Manager and department
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is(pg_temp.probe($$select api.update_employee('20000000-0000-0000-0000-000000000005', 'Rep Delta', 'Sales Representative',
                            null, null, null, null, null, '20000000-0000-0000-0000-000000000003')$$),
  'ERROR 42501 MFA_REQUIRED', 'enforced, aal1: a manager change needs step-up');
select is(pg_temp.probe($$select api.update_employee('20000000-0000-0000-0000-000000000005', 'Rep Delta', 'Sales Representative',
                            null, null, null, '21000000-0000-0000-0000-000000000001', null, '20000000-0000-0000-0000-000000000002')$$),
  'ERROR 42501 MFA_REQUIRED', 'enforced, aal1: a department change needs step-up');
select is(pg_temp.probe($$select api.update_employee('20000000-0000-0000-0000-000000000005', 'Rep Delta (Mansoura)', 'Sales Representative',
                            null, null, null, null, null, '20000000-0000-0000-0000-000000000002')$$),
  'OK', 'enforced, aal1: a name change needs no step-up');
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a7');
select is(pg_temp.probe($$select api.update_employee('20000000-0000-0000-0000-000000000005', 'Rep Delta', 'Sales Representative',
                            null, null, null, '21000000-0000-0000-0000-000000000001', null, '20000000-0000-0000-0000-000000000003')$$),
  'OK', 'enforced, aal2: manager and department changes are allowed');

-- 3c. Territory assignments and the territory tree
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is(pg_temp.probe($$select api.assign_employee_territory('20000000-0000-0000-0000-000000000009',
                            (select id from core.territories where code = 'DELTA'), 'member')$$),
  'ERROR 42501 MFA_REQUIRED', 'enforced, aal1: assigning a territory needs step-up');
select is(pg_temp.probe($$select api.assign_employee_territory('20000000-0000-0000-0000-000000000005',
                            (select id from core.territories where code = 'DELTA'), 'manager')$$),
  'ERROR 42501 MFA_REQUIRED', 'enforced, aal1: retyping member → manager needs step-up');
select is(pg_temp.probe($$select api.assign_employee_territory('20000000-0000-0000-0000-000000000005',
                            (select id from core.territories where code = 'DELTA'), 'member') ->> 'changed'$$),
  'OK', 'enforced, aal1: re-sending an unchanged assignment is a no-op without step-up');
select is(pg_temp.probe($$select api.end_employee_territory((select id from core.employee_territories
                            where employee_id = '20000000-0000-0000-0000-000000000005' and valid_to is null))$$),
  'ERROR 42501 MFA_REQUIRED', 'enforced, aal1: ending a territory assignment needs step-up');
select is(pg_temp.probe($$select api.move_territory('10000000-0000-0000-0000-000000000003',
                            (select id from core.territories where code = 'DELTA'), 'regroup')$$),
  'ERROR 42501 MFA_REQUIRED', 'enforced, aal1: moving a territory (it changes every territory scope above it) needs step-up');
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a7');
select is(pg_temp.probe($$select api.assign_employee_territory('20000000-0000-0000-0000-000000000009',
                            (select id from core.territories where code = 'DELTA'), 'member')$$),
  'OK', 'enforced, aal2: assigning is allowed');
select is(pg_temp.probe($$select api.end_employee_territory((select id from core.employee_territories
                            where employee_id = '20000000-0000-0000-0000-000000000005' and valid_to is null))$$),
  'OK', 'enforced, aal2: ending is allowed');
select is(pg_temp.probe($$select api.move_territory('10000000-0000-0000-0000-000000000003',
                            (select id from core.territories where code = 'DELTA'), 'regroup')$$),
  'OK', 'enforced, aal2: moving is allowed');

-- 3d. Enforcement off: unchanged behaviour at aal1
select tests.clear_authentication();
select pg_temp.enforce(false);
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is(pg_temp.probe($$select api.set_employment_status('20000000-0000-0000-0000-000000000005', 'suspended', 'x')$$),
  'OK', 'not enforced: deactivation at aal1 works as before');
select is(pg_temp.probe($$select api.set_employment_status('20000000-0000-0000-0000-000000000004', 'active', 'back')$$),
  'OK', 'not enforced: reactivation at aal1 works as before');
select is(pg_temp.probe($$select api.update_employee('20000000-0000-0000-0000-000000000005', 'Rep Delta', 'Sales Representative',
                            null, null, null, '21000000-0000-0000-0000-000000000001', null, '20000000-0000-0000-0000-000000000003')$$),
  'OK', 'not enforced: manager and department changes at aal1 work as before');
select is(pg_temp.probe($$select api.assign_employee_territory('20000000-0000-0000-0000-000000000009',
                            (select id from core.territories where code = 'DELTA'), 'member')$$),
  'OK', 'not enforced: territory assignment at aal1 works as before');
select is(pg_temp.probe($$select api.move_territory('10000000-0000-0000-0000-000000000003',
                            (select id from core.territories where code = 'DELTA'), 'regroup')$$),
  'OK', 'not enforced: moving a territory at aal1 works as before');
select tests.clear_authentication();

select * from finish();
rollback;
