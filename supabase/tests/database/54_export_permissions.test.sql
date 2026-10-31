-- Per-kind export permissions (20261104001100_export_permissions.sql; owner decision 2026-10-31).
--   * every CSV export kind needs its own <module>.<resource>.export permission next to its read
--     permission; all of them are sensitive and MFA-gated
--   * the system roles that could export a kind before can still export it, at the same scope;
--     nobody gained or lost an export (checked user by user against the previous whitelist)
--   * without the export permission each kind is refused, naming the missing permission
--   * security.mfa_enforced on: aal1 → MFA_REQUIRED for every kind, aal2 → allowed; a non-holder
--     still sees PERMISSION_DENIED
--   * the database whitelist (audit.export_kinds) is the one the app mirrors
--   users: a1 owner · a2 sales director · a3 area manager · a4 rep Cairo · a5 rep Delta ·
--          a6 finance officer · a7 admin (gets a test-only reader role) · a8 inventory manager
begin;
select tests.load_fixture();
set constraints all immediate;
select plan(49);

-- Runs a statement; returns 'OK' or 'ERROR <sqlstate> <CODE>' (rolled back in its subtransaction).
create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return 'ERROR ' || sqlstate || ' ' || split_part(sqlerrm, ':', 1);
end $$;
grant execute on function pg_temp.try(text) to authenticated;

-- api.log_export for every kind, as the current session; one result per kind, in this order.
create function pg_temp.export_all() returns text[] language sql as $$
  select array_agg(pg_temp.try(format('select api.log_export(%L, ''{}'')', k)) order by n)
  from unnest(array['orders','order_lines','invoices','payments','aging','visits','customers','stock','tracking'])
       with ordinality u(k, n)
$$;
grant execute on function pg_temp.export_all() to authenticated;

-- The kinds whose rule (alternatives ORed, permissions ANDed) the given user satisfies, read
-- through authz.has_permission with that user's claims. Leaves no claims behind.
create function pg_temp.allowed(p_user uuid, p_whitelist jsonb) returns text[] language plpgsql as $$
declare r text[];
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  select coalesce(array_agg(k.key order by k.key), '{}') into r
  from jsonb_each(p_whitelist) k
  where exists (select 1 from jsonb_array_elements(k.value -> 'perms') a(value)
                where not exists (select 1 from jsonb_array_elements_text(a.value) p(code)
                                  where not authz.has_permission(p.code)));
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return r;
end $$;

-- The whitelist before this change (20261104000710_audit4_export_log.sql), permissions only.
create temporary table t_old (w jsonb);
insert into t_old values ('{
  "orders":      { "perms": [["sales.order.read", "sales.order.export"]] },
  "order_lines": { "perms": [["sales.order.read", "sales.order.export"]] },
  "invoices":    { "perms": [["finance.invoice.read"]] },
  "payments":    { "perms": [["finance.payment.read"]] },
  "aging":       { "perms": [["finance.page.aging"], ["finance.ledger.read"]] },
  "visits":      { "perms": [["field.visit.read"]] },
  "customers":   { "perms": [["crm.customer.read", "crm.customer.export"]] },
  "stock":       { "perms": [["inventory.stock.read"]] },
  "tracking":    { "perms": [["field.tracking.read"]] }
}');

-- Role grants of a permission as 'role:scope', sorted.
create function pg_temp.grants_of(p_perm text) returns text[] language sql as $$
  select coalesce(array_agg(r.code || ':' || rp.scope order by r.code), '{}')
  from authz.role_permissions rp join authz.roles r on r.id = rp.role_id
  where rp.permission_code = p_perm
$$;

-- ===========================================================================
-- Catalogue
-- ===========================================================================
select is((select array_agg(code order by code) from authz.permissions where code like '%.export'),
  array['crm.customer.export','field.tracking.export','field.visit.export','finance.aging.export',
        'finance.invoice.export','finance.payment.export','inventory.stock.export','sales.order.export'],
  'one export permission per export kind (orders and order lines share sales.order.export)');
select ok((select bool_and(is_sensitive and requires_mfa and not supports_limit) from authz.permissions where code like '%.export'),
  'every export permission is sensitive, MFA-gated and takes no limit');
select is((select array_agg(p.code order by p.code) from authz.permissions p where p.code like '%.export'
             and p.module <> split_part(p.code, '.', 1)), null::text[],
  'each export permission belongs to its module');
select is((select allowed_scopes from authz.permissions where code = 'field.tracking.export'),
          (select allowed_scopes from authz.permissions where code = 'field.tracking.read'),
  'field.tracking.export allows the scopes of field.tracking.read (no department or warehouse scope)');
select is((select count(*)::int from authz.permissions e join authz.permissions r on r.code = replace(e.code, '.export', '.read')
           where e.code in ('finance.invoice.export','finance.payment.export','field.visit.export','inventory.stock.export')
             and e.allowed_scopes = r.allowed_scopes), 4,
  'the other new export permissions allow the scopes of their read permission');

-- ===========================================================================
-- Same roles, same scope as before
-- ===========================================================================
select is(pg_temp.grants_of('finance.invoice.export'), pg_temp.grants_of('finance.invoice.read'),
  'finance.invoice.export: the roles and scopes of finance.invoice.read');
select is(pg_temp.grants_of('finance.payment.export'), pg_temp.grants_of('finance.payment.read'),
  'finance.payment.export: the roles and scopes of finance.payment.read');
select is(pg_temp.grants_of('field.visit.export'), pg_temp.grants_of('field.visit.read'),
  'field.visit.export: the roles and scopes of field.visit.read');
select is(pg_temp.grants_of('inventory.stock.export'), pg_temp.grants_of('inventory.stock.read'),
  'inventory.stock.export: the roles and scopes of inventory.stock.read');
select is(pg_temp.grants_of('field.tracking.export'), pg_temp.grants_of('field.tracking.read'),
  'field.tracking.export: the roles and scopes of field.tracking.read');
select is(pg_temp.grants_of('finance.aging.export'),
  (select array_agg(x order by x) from (select distinct r.code || ':' || rp.scope as x
     from authz.role_permissions rp join authz.roles r on r.id = rp.role_id
     where rp.permission_code in ('finance.page.aging', 'finance.ledger.read')) s),
  'finance.aging.export: the roles of finance.page.aging or finance.ledger.read');
-- The resulting role matrix (docs/AUTHORIZATION.md §4).
select is(array[pg_temp.grants_of('finance.invoice.export'), pg_temp.grants_of('finance.payment.export')],
  array[array['area_manager:territory','collection_officer:all','finance_officer:all','sales_director:all','sales_rep:own'],
        array['area_manager:team','collection_officer:own','finance_officer:all','sales_director:all','sales_rep:own']],
  'matrix: invoice and payment exports');
select is(pg_temp.grants_of('finance.aging.export'), array['collection_officer:all','finance_officer:all'],
  'matrix: aging export');
select is(pg_temp.grants_of('field.visit.export'), array['area_manager:team','sales_director:all','sales_rep:own'],
  'matrix: visit export');
select is(pg_temp.grants_of('inventory.stock.export'),
  array['area_manager:all','inventory_manager:all','quality_manager:all','sales_director:all','sales_rep:own'],
  'matrix: stock export');
select is(pg_temp.grants_of('field.tracking.export'), array['area_manager:team','sales_director:team'],
  'matrix: tracking export');
select is(pg_temp.grants_of('crm.customer.export') || pg_temp.grants_of('sales.order.export'),
  array['marketing_director:all','sales_director:all','sales_director:all'],
  'matrix: customer and order exports are unchanged');
select is((select count(*)::int from authz.role_permissions rp join authz.roles r on r.id = rp.role_id
           where rp.permission_code like '%.export' and (r.is_owner_role or r.code = 'admin')), 0,
  'the owner role (implicit) and the IT admin hold no explicit export grant');

-- Nobody gains or loses: every fixture user may export exactly the kinds they could before.
create temporary table t_users as
select u.id, pg_temp.allowed(u.id, (select w from t_old)) as before, pg_temp.allowed(u.id, audit.export_kinds()) as after
from auth.users u where u.email like '%@honest.test';
select is((select count(*)::int from t_users where before is distinct from after), 0,
  'every user may export the same kinds as before');
select is((select jsonb_object_agg(split_part(u.email, '@', 1), t.after order by u.email) from t_users t join auth.users u using (id)),
  '{"admin": [], "am.cairo": ["invoices", "payments", "stock", "tracking", "visits"],
    "finance": ["aging", "invoices", "payments"], "inventory": ["stock"], "new.hire": [],
    "owner": ["aging", "customers", "invoices", "order_lines", "orders", "payments", "stock", "tracking", "visits"],
    "rep.cairo": ["invoices", "payments", "stock", "visits"], "rep.delta": ["invoices", "payments", "stock", "visits"],
    "sd": ["customers", "invoices", "order_lines", "orders", "payments", "stock", "tracking", "visits"]}'::jsonb,
  'who may export what (the fixture users)');

-- The same through api.log_export (enforcement off).
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(pg_temp.export_all(),
  array['ERROR 42501 PERMISSION_DENIED','ERROR 42501 PERMISSION_DENIED','OK','OK','ERROR 42501 PERMISSION_DENIED','OK',
        'ERROR 42501 PERMISSION_DENIED','OK','ERROR 42501 PERMISSION_DENIED'],
  'a rep exports invoices, payments, visits and stock, as before');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(pg_temp.export_all(),
  array['ERROR 42501 PERMISSION_DENIED','ERROR 42501 PERMISSION_DENIED','OK','OK','ERROR 42501 PERMISSION_DENIED','OK',
        'ERROR 42501 PERMISSION_DENIED','OK','OK'],
  'an area manager also exports the team day summary, as before');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.export_all(),
  array['ERROR 42501 PERMISSION_DENIED','ERROR 42501 PERMISSION_DENIED','OK','OK','OK','ERROR 42501 PERMISSION_DENIED',
        'ERROR 42501 PERMISSION_DENIED','ERROR 42501 PERMISSION_DENIED','ERROR 42501 PERMISSION_DENIED'],
  'finance exports invoices, payments and aging, as before');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(pg_temp.export_all(), array_fill('OK'::text, array[9]), 'the owner exports every kind');
select tests.clear_authentication();

-- ===========================================================================
-- Refused without the export permission
-- ===========================================================================
-- A test-only role with every read permission an export uses, and no export permission.
insert into authz.roles (id, code, name_en) values ('54000000-0000-0000-0000-0000000000e1', 'test_list_reader', 'Test list reader');
insert into authz.role_permissions (role_id, permission_code, scope)
select '54000000-0000-0000-0000-0000000000e1', c, 'all'
from unnest(array['sales.order.read','finance.invoice.read','finance.payment.read','finance.page.aging','finance.ledger.read',
                  'field.visit.read','crm.customer.read','inventory.stock.read','field.tracking.read']) c;
insert into authz.user_roles (user_id, role_id) values ('00000000-0000-0000-0000-0000000000a7', '54000000-0000-0000-0000-0000000000e1');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select throws_ok($$select api.log_export('orders', '{}')$$, '42501', 'PERMISSION_DENIED: sales.order.export',
  'orders: refused without sales.order.export');
select throws_ok($$select api.log_export('order_lines', '{}')$$, '42501', 'PERMISSION_DENIED: sales.order.export',
  'order lines: refused without sales.order.export');
select throws_ok($$select api.log_export('invoices', '{}')$$, '42501', 'PERMISSION_DENIED: finance.invoice.export',
  'invoices: refused without finance.invoice.export');
select throws_ok($$select api.log_export('payments', '{}')$$, '42501', 'PERMISSION_DENIED: finance.payment.export',
  'payments: refused without finance.payment.export');
select throws_ok($$select api.log_export('aging', '{}')$$, '42501', 'PERMISSION_DENIED: finance.aging.export',
  'aging: refused without finance.aging.export, whichever read permission is held');
select throws_ok($$select api.log_export('visits', '{}')$$, '42501', 'PERMISSION_DENIED: field.visit.export',
  'visits: refused without field.visit.export');
select throws_ok($$select api.log_export('customers', '{}')$$, '42501', 'PERMISSION_DENIED: crm.customer.export',
  'customers: refused without crm.customer.export');
select throws_ok($$select api.log_export('stock', '{}')$$, '42501', 'PERMISSION_DENIED: inventory.stock.export',
  'stock: refused without inventory.stock.export');
select throws_ok($$select api.log_export('tracking', '{}')$$, '42501', 'PERMISSION_DENIED: field.tracking.export',
  'tracking: refused without field.tracking.export');
select tests.clear_authentication();
select is((select count(*)::int from audit.security_events where user_id = '00000000-0000-0000-0000-0000000000a7' and event_type = 'export'),
  0, 'a refused export writes no export event');

-- With the export permissions as well, every kind is allowed.
insert into authz.role_permissions (role_id, permission_code, scope)
select '54000000-0000-0000-0000-0000000000e1', c, 'all'
from unnest(array['sales.order.export','finance.invoice.export','finance.payment.export','finance.aging.export',
                  'field.visit.export','crm.customer.export','inventory.stock.export','field.tracking.export']) c;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is(pg_temp.export_all(), array_fill('OK'::text, array[9]), 'read + export permission: every kind is allowed');
select tests.clear_authentication();

-- The export permission without the read permission is not enough (the read permission is named).
insert into authz.user_permission_overrides (user_id, permission_code, effect, scope, reason)
values ('00000000-0000-0000-0000-0000000000a8', 'field.tracking.export', 'grant', 'all', 'suite 54');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_ok($$select api.log_export('tracking', '{}')$$, '42501', 'PERMISSION_DENIED: field.tracking.read',
  'the export permission alone does not open a list the user cannot read');
select tests.clear_authentication();

-- A deny override on the export permission beats the role grant.
insert into authz.user_permission_overrides (user_id, permission_code, effect, reason)
values ('00000000-0000-0000-0000-0000000000a2', 'finance.invoice.export', 'deny', 'suite 54');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select throws_ok($$select api.log_export('invoices', '{}')$$, '42501', 'PERMISSION_DENIED: finance.invoice.export',
  'a deny override on finance.invoice.export blocks the invoice export');
select is(pg_temp.try($$select api.log_export('payments', '{}')$$), 'OK', 'and leaves the other kinds alone');
select tests.clear_authentication();

-- ===========================================================================
-- MFA step-up (security.mfa_enforced on)
-- ===========================================================================
update core.system_settings set value = 'true'::jsonb where key = 'security.mfa_enforced';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(pg_temp.export_all(), array_fill('ERROR 42501 MFA_REQUIRED'::text, array[9]),
  'MFA on, aal1: every kind is refused to the owner with MFA_REQUIRED');
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a1');
select is(pg_temp.export_all(), array_fill('OK'::text, array[9]), 'MFA on, aal2: the owner exports every kind');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(pg_temp.export_all(),
  array['ERROR 42501 PERMISSION_DENIED','ERROR 42501 PERMISSION_DENIED','ERROR 42501 MFA_REQUIRED','ERROR 42501 MFA_REQUIRED',
        'ERROR 42501 PERMISSION_DENIED','ERROR 42501 MFA_REQUIRED','ERROR 42501 PERMISSION_DENIED','ERROR 42501 MFA_REQUIRED',
        'ERROR 42501 PERMISSION_DENIED'],
  'MFA on, aal1: the rep''s exports need MFA; kinds the rep cannot export still say PERMISSION_DENIED');
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a4');
select is(pg_temp.export_all(),
  array['ERROR 42501 PERMISSION_DENIED','ERROR 42501 PERMISSION_DENIED','OK','OK','ERROR 42501 PERMISSION_DENIED','OK',
        'ERROR 42501 PERMISSION_DENIED','OK','ERROR 42501 PERMISSION_DENIED'],
  'MFA on, aal2: the rep exports the same kinds as with enforcement off');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try($$select api.log_export('aging', '{}')$$), 'ERROR 42501 MFA_REQUIRED',
  'MFA on, aal1: the aging export (either alternative) needs MFA');
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try($$select api.log_export('aging', '{}')$$), 'OK', 'MFA on, aal2: finance exports the aging');
select tests.clear_authentication();
update core.system_settings set value = 'false'::jsonb where key = 'security.mfa_enforced';

-- ===========================================================================
-- The whitelist the app mirrors (src/modules/reports/kinds.ts)
-- ===========================================================================
select is((select jsonb_object_agg(key, value -> 'perms') from jsonb_each(audit.export_kinds())),
  '{"orders":      [["sales.order.read", "sales.order.export"]],
    "order_lines": [["sales.order.read", "sales.order.export"]],
    "invoices":    [["finance.invoice.read", "finance.invoice.export"]],
    "payments":    [["finance.payment.read", "finance.payment.export"]],
    "aging":       [["finance.page.aging", "finance.aging.export"], ["finance.ledger.read", "finance.aging.export"]],
    "visits":      [["field.visit.read", "field.visit.export"]],
    "customers":   [["crm.customer.read", "crm.customer.export"]],
    "stock":       [["inventory.stock.read", "inventory.stock.export"]],
    "tracking":    [["field.tracking.read", "field.tracking.export"]]}'::jsonb,
  'whitelist: each kind requires its read permission and its export permission');
select is((select count(*)::int from jsonb_each(audit.export_kinds()) k, jsonb_array_elements(k.value -> 'perms') a(rule)
           where (select count(*) from jsonb_array_elements_text(a.rule) p(code)
                  join authz.permissions ap on ap.code = p.code
                  where p.code like '%.export' and ap.requires_mfa) <> 1), 0,
  'whitelist: every alternative of every kind contains exactly one MFA-gated export permission');
select is((select count(*)::int from jsonb_each(audit.export_kinds()) k, jsonb_array_elements(k.value -> 'perms') a(rule),
                  jsonb_array_elements_text(a.rule) p(code)
           where not exists (select 1 from authz.permissions ap where ap.code = p.code)), 0,
  'whitelist: every permission it names exists');
select is((select jsonb_object_agg(key, value -> 'filters') from jsonb_each(audit.export_kinds())),
  '{"orders": ["status", "from", "to"], "order_lines": ["status", "from", "to"],
    "invoices": ["status", "bucket", "customer", "from", "to"], "payments": ["status", "customer", "from", "to"],
    "aging": [], "visits": ["status", "who", "from", "to"], "customers": ["q", "stage", "territory", "specialty"],
    "stock": ["warehouse", "brand", "product"], "tracking": ["date"]}'::jsonb,
  'whitelist: the filter keys are unchanged');
select ok((select p.provolatile = 'i' and not p.prosecdef and p.proconfig @> array['search_path=""']
           and not has_function_privilege('authenticated', p.oid, 'execute')
           and not has_function_privilege('anon', p.oid, 'execute')
           and not has_function_privilege('public', p.oid, 'execute')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'audit' and p.proname = 'export_kinds'),
  'audit.export_kinds stays an internal immutable invoker function with search_path = ''''');

select * from finish();
rollback;
