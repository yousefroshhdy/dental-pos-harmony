-- MFA step-up for sensitive permissions (20261103000600_mfa_step_up.sql, AUTHORIZATION §6.7).
--   * security.mfa_enforced ships false: behaviour is unchanged (the other suites run that way)
--   * enforced: a requires_mfa permission needs JWT aal = aal2; owners included
--   * a non-holder still sees PERMISSION_DENIED, never MFA_REQUIRED
--   * non-sensitive permissions are unaffected
--   users: a1 owner · a4 rep Cairo · a6 finance officer · a7 admin
begin;
select tests.load_fixture();
select plan(64);
set constraints all immediate;

-- Runs a statement; returns 'OK' or 'ERROR <sqlstate> <CODE>' (rolled back in its subtransaction).
create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return 'ERROR ' || sqlstate || ' ' || split_part(sqlerrm, ':', 1);
end $$;
grant execute on function pg_temp.try(text) to authenticated;

-- authz.require(perm) for a user with the given aal claim (NULL = no aal claim), called directly
-- (authz.require is not client-callable). Leaves no claims behind.
create function pg_temp.req(p_user text, p_aal text, p_perm text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims',
    (jsonb_build_object('sub', p_user, 'role', 'authenticated')
       || case when p_aal is null then '{}'::jsonb else jsonb_build_object('aal', p_aal) end)::text, true);
  perform set_config('request.jwt.claim.sub', p_user, true);
  r := pg_temp.try(format('select authz.require(%L)', p_perm));
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return r;
end $$;

create function pg_temp.enforce(p_on boolean) returns void language sql as $$
  update core.system_settings set value = to_jsonb(p_on) where key = 'security.mfa_enforced'
$$;

-- ---- catalogue and setting ----
select is((select is_nullable || ' ' || column_default from information_schema.columns
            where table_schema = 'authz' and table_name = 'permissions' and column_name = 'requires_mfa'),
          'NO false', 'authz.permissions.requires_mfa is NOT NULL DEFAULT false');
select is((select array_agg(code order by code) from authz.permissions where requires_mfa and code <> 'admin.import.run'),
          array['admin.override.manage','admin.role.assign','admin.role.manage','admin.settings.manage',
                'admin.user.suspend','admin.workflow.manage','audit.row_image.unmask',
                'catalog.price.manage','crm.customer.export','finance.credit_limit.change','finance.payment.reverse',
                'inventory.quarantine.release','perf.commission.calculate','sales.order.export','sales.return.credit',
                'wf.decide.write_off'],
          'the sensitive set requires MFA (admin.import.run too, once it exists; extended by 20261104000300 and 20261104000710)');
select is((select count(*)::int from authz.permissions where requires_mfa = false and code in
            ('crm.customer.read','sales.order.create','finance.payment.record','finance.payment.read','admin.user.create')),
          5, 'ordinary permissions do not require MFA');
select is((select value from core.system_settings where key = 'security.mfa_enforced'), 'false'::jsonb,
          'security.mfa_enforced ships false');

-- ---- privileges ----
select ok(not has_function_privilege('authenticated', 'authz.require_mfa(text)', 'execute'), 'authz.require_mfa is internal');
select ok(not has_function_privilege('authenticated', 'authz.mfa_enforced()', 'execute'), 'authz.mfa_enforced is internal');
select ok(not has_function_privilege('authenticated', 'authz.session_aal()', 'execute'), 'authz.session_aal is internal');
select ok(not has_function_privilege('authenticated', 'authz.require(text)', 'execute'), 'authz.require keeps its privileges');
select ok(has_function_privilege('authenticated', 'api.my_mfa_status()', 'execute'), 'my_mfa_status is callable by users');
select ok(not has_function_privilege('anon', 'api.my_mfa_status()', 'execute'), 'my_mfa_status is not callable by anon');

-- ---- enforcement OFF: unchanged behaviour ----
select is(pg_temp.req('00000000-0000-0000-0000-0000000000a6', 'aal1', 'finance.payment.reverse'), 'OK',
          'off: finance reverses at aal1');
select is(pg_temp.req('00000000-0000-0000-0000-0000000000a6', null, 'finance.payment.reverse'), 'OK',
          'off: finance reverses without an aal claim');
select is(pg_temp.req('00000000-0000-0000-0000-0000000000a1', 'aal1', 'admin.role.assign'), 'OK',
          'off: the owner assigns roles at aal1');
select is(pg_temp.req('00000000-0000-0000-0000-0000000000a4', 'aal1', 'finance.payment.reverse'), 'ERROR 42501 PERMISSION_DENIED',
          'off: a rep is still denied');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is(pg_temp.try($$select api.suspend_user('00000000-0000-0000-0000-0000000000a4', 'synthetic test')$$), 'OK',
          'off: admin suspends at aal1');
select is(pg_temp.try($$select api.reactivate_user('00000000-0000-0000-0000-0000000000a4', 'synthetic test')$$), 'OK',
          'off: admin reactivates at aal1');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(pg_temp.try($$select api.reverse_payment(gen_random_uuid(), 'synthetic test')$$), 'ERROR P0002 NOT_FOUND',
          'off: the owner passes the reversal gate at aal1 (unknown payment)');
select is((select (api.my_mfa_status() ->> 'enforced')::boolean), false, 'off: my_mfa_status reports the switch off');
select tests.clear_authentication();

-- ---- enforcement ON ----
select pg_temp.enforce(true);
select is((select authz.mfa_enforced()), true, 'the switch reads as on');

-- direct authz.require
select is(pg_temp.req('00000000-0000-0000-0000-0000000000a6', 'aal1', 'finance.payment.reverse'), 'ERROR 42501 MFA_REQUIRED',
          'on: finance at aal1 is refused a reversal');
select is(pg_temp.req('00000000-0000-0000-0000-0000000000a6', null, 'finance.payment.reverse'), 'ERROR 42501 MFA_REQUIRED',
          'on: no aal claim counts as not verified');
select is(pg_temp.req('00000000-0000-0000-0000-0000000000a6', 'aal2', 'finance.payment.reverse'), 'OK',
          'on: finance at aal2 may reverse');
select is(pg_temp.req('00000000-0000-0000-0000-0000000000a4', 'aal1', 'finance.payment.reverse'), 'ERROR 42501 PERMISSION_DENIED',
          'on: a non-holder gets PERMISSION_DENIED, not MFA_REQUIRED');
select is(pg_temp.req('00000000-0000-0000-0000-0000000000a4', 'aal2', 'finance.payment.reverse'), 'ERROR 42501 PERMISSION_DENIED',
          'on: aal2 grants nothing by itself');
select is(pg_temp.req('00000000-0000-0000-0000-0000000000a6', 'aal1', 'finance.payment.read'), 'OK',
          'on: a non-sensitive permission is unaffected at aal1 (finance)');
select is(pg_temp.req('00000000-0000-0000-0000-0000000000a4', 'aal1', 'crm.customer.read'), 'OK',
          'on: a non-sensitive permission is unaffected at aal1 (rep)');
select is(pg_temp.req('00000000-0000-0000-0000-0000000000a1', 'aal1', 'admin.role.assign'), 'ERROR 42501 MFA_REQUIRED',
          'on: the owner is also refused at aal1');
select is(pg_temp.req('00000000-0000-0000-0000-0000000000a1', 'aal2', 'admin.role.assign'), 'OK',
          'on: the owner at aal2 may assign roles');
select is(pg_temp.req('00000000-0000-0000-0000-0000000000a1', 'aal1', 'crm.customer.read'), 'OK',
          'on: the owner at aal1 keeps non-sensitive permissions');
select is((select count(*)::int from authz.permissions p
            where p.requires_mfa and pg_temp.req('00000000-0000-0000-0000-0000000000a1', 'aal1', p.code) = 'ERROR 42501 MFA_REQUIRED'),
          (select count(*)::int from authz.permissions where requires_mfa),
          'on: every requires_mfa permission is refused to the owner at aal1');
select is((select count(*)::int from authz.permissions p
            where p.requires_mfa and pg_temp.req('00000000-0000-0000-0000-0000000000a1', 'aal2', p.code) = 'OK'),
          (select count(*)::int from authz.permissions where requires_mfa),
          'on: every requires_mfa permission is allowed to the owner at aal2');
select is(pg_temp.req('00000000-0000-0000-0000-0000000000a6', 'AAL2', 'finance.payment.reverse'), 'ERROR 42501 MFA_REQUIRED',
          'on: only the exact claim aal2 counts');
select throws_like($$select authz.require_mfa('finance.payment.reverse')$$,
                   'MFA_REQUIRED: finance.payment.reverse needs%', 'the message names the permission');

-- the claim is read like auth.jwt(): request.jwt.claim wins over request.jwt.claims
select set_config('request.jwt.claim', '{"sub":"00000000-0000-0000-0000-0000000000a6","aal":"aal2"}', true);
select is((select authz.session_aal()), 'aal2', 'request.jwt.claim is read first, like auth.jwt()');
select set_config('request.jwt.claim', '', true);

-- through the real commands (PostgREST role, tests.authenticate_as = aal1)
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is(pg_temp.try($$select api.suspend_user('00000000-0000-0000-0000-0000000000a4', 'synthetic test')$$),
          'ERROR 42501 MFA_REQUIRED', 'on: admin at aal1 cannot suspend');
select is((select status from core.user_profiles where user_id = '00000000-0000-0000-0000-0000000000a4'), 'active',
          'on: the refused suspension changed nothing');
select is(pg_temp.try($$select api.revoke_role(gen_random_uuid(), 'synthetic test')$$), 'ERROR 42501 MFA_REQUIRED',
          'on: admin at aal1 cannot revoke roles');
select is(pg_temp.try($$select api.grant_role('00000000-0000-0000-0000-0000000000a5', (select id from authz.roles where code = 'sales_rep'), null, 'synthetic test')$$),
          'ERROR 42501 MFA_REQUIRED', 'on: admin at aal1 cannot grant roles');
select is(pg_temp.try($$select api.create_role('synthetic_mfa_role', 'Synthetic MFA role')$$), 'ERROR 42501 MFA_REQUIRED',
          'on: admin at aal1 cannot create roles');
select is(pg_temp.try($$select api.set_role_permission((select id from authz.roles where code = 'sales_rep'), 'crm.customer.read', 'own')$$),
          'ERROR 42501 MFA_REQUIRED', 'on: admin at aal1 cannot set role permissions');
select is(pg_temp.try($$select api.create_employee('E-SYN-39', 'Synthetic Employee', 'Tester')$$), 'OK',
          'on: admin at aal1 still creates employees (non-sensitive)');
select is((select (api.my_mfa_status() ->> 'enforced')::boolean), true, 'on: my_mfa_status reports the switch on');
select is((select api.my_mfa_status() ->> 'aal'), null, 'on: a session without an aal claim reports none');
select is((select api.my_mfa_status() -> 'required_permissions'),
          '["admin.override.manage","admin.role.assign","admin.role.manage","admin.settings.manage","admin.user.suspend","admin.workflow.manage"]'::jsonb,
          'on: my_mfa_status lists the gated permissions the admin holds');

select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a7');
select is(pg_temp.try($$select api.suspend_user('00000000-0000-0000-0000-0000000000a4', 'synthetic test')$$), 'OK',
          'on: admin at aal2 suspends');
select is(pg_temp.try($$select api.reactivate_user('00000000-0000-0000-0000-0000000000a4', 'synthetic test')$$), 'OK',
          'on: admin at aal2 reactivates');
select is(pg_temp.try($$select api.revoke_role(gen_random_uuid(), 'synthetic test')$$), 'ERROR P0002 NOT_FOUND',
          'on: admin at aal2 passes the revoke gate (unknown assignment)');
select is(pg_temp.try($$select api.create_role('synthetic_mfa_role', 'Synthetic MFA role')$$), 'OK',
          'on: admin at aal2 creates a role');
select is(pg_temp.try($$select api.set_role_permission((select id from authz.roles where code = 'synthetic_mfa_role'), 'admin.user.read', 'all')$$),
          'OK', 'on: admin at aal2 sets a role permission');
select is((select api.my_mfa_status() ->> 'aal'), 'aal2', 'on: my_mfa_status reports aal2');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(pg_temp.try($$select api.reverse_payment(gen_random_uuid(), 'synthetic test')$$), 'ERROR 42501 MFA_REQUIRED',
          'on: the owner at aal1 cannot reverse a payment');
select is(pg_temp.try($$select api.set_price_list_item('54000000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000001', 1100)$$),
          'ERROR 42501 MFA_REQUIRED', 'on: the owner at aal1 cannot change a price');
select is((select jsonb_array_length(api.my_mfa_status() -> 'required_permissions')),
          (select count(*)::int from authz.permissions where requires_mfa), 'on: the owner holds every gated permission');
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a1');
select is(pg_temp.try($$select api.reverse_payment(gen_random_uuid(), 'synthetic test')$$), 'ERROR P0002 NOT_FOUND',
          'on: the owner at aal2 passes the reversal gate');
select is(pg_temp.try($$select api.set_price_list_item('54000000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000001', 1100)$$),
          'OK', 'on: the owner at aal2 changes a price');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try($$select api.reverse_payment(gen_random_uuid(), 'synthetic test')$$), 'ERROR 42501 MFA_REQUIRED',
          'on: finance at aal1 cannot reverse a payment');
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try($$select api.reverse_payment(gen_random_uuid(), 'synthetic test')$$), 'ERROR P0002 NOT_FOUND',
          'on: finance at aal2 passes the reversal gate');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select api.my_mfa_status() -> 'required_permissions'), '[]'::jsonb, 'on: a rep holds no gated permission');
select is(pg_temp.try($$select api.reverse_payment(gen_random_uuid(), 'synthetic test')$$), 'ERROR 42501 PERMISSION_DENIED',
          'on: a rep is denied the reversal, not asked for MFA');
select tests.clear_authentication();

-- ---- seed helpers ----
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a6');
select is((select current_setting('request.jwt.claims')::jsonb ->> 'aal'), 'aal2', 'authenticate_as_aal2 sets aal2');
select is((select auth.uid()), '00000000-0000-0000-0000-0000000000a6'::uuid, 'authenticate_as_aal2 sets the user');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select current_setting('request.jwt.claims')::jsonb ? 'aal'), false, 'authenticate_as is unchanged (no aal claim)');
select tests.clear_authentication();

-- ---- switching off again takes effect immediately ----
select pg_temp.enforce(false);
select is(pg_temp.req('00000000-0000-0000-0000-0000000000a6', 'aal1', 'finance.payment.reverse'), 'OK',
          'off again: finance reverses at aal1');
select is((select count(*)::int from audit.audit_log where table_name = 'system_settings' and action = 'UPDATE'
            and (new_data ->> 'key') = 'security.mfa_enforced'), 2, 'switching MFA enforcement is audited');

select * from finish();
rollback;
