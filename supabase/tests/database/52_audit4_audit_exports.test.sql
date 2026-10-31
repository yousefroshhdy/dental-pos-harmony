-- Audit-4 A-LM2 and A-L4 (migrations 20261104000700_audit4_row_image_masks.sql and
-- 20261104000710_audit4_export_log.sql).
--   A-LM2: row-image masking covers values derivable from balance / credit limit (exposure,
--          credit_excess), matches keys case-insensitively, covers tel / whatsapp / msisdn and
--          geo / location / coordinates containers, at any depth.
--   A-L4:  api.log_export is the server-side export gate: kind whitelist, the kind's permissions,
--          MFA step-up on the export permissions, filters without personal data, a per-user rate
--          limit, and one audit.security_events row per export; api.log_export_result adds the
--          final row count.
--   users: a1 owner · a2 sales director (holds both export permissions) · a4 rep Cairo (no export
--          permission) · a6 finance officer (invoices, aging) · a7 admin
begin;
select tests.load_fixture();
set constraints all immediate;
select plan(66);

-- Runs a statement; returns 'OK' or 'ERROR <sqlstate> <CODE>' (rolled back in its subtransaction).
create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return 'ERROR ' || sqlstate || ' ' || split_part(sqlerrm, ':', 1);
end $$;
grant execute on function pg_temp.try(text) to authenticated;

-- Mask an image as a reader holding no unmask permission (the default for row-image readers).
create function pg_temp.masked(p_new jsonb) returns jsonb language sql as $$
  select audit.mask_entry('wf', 'approval_requests', null, p_new, '{}'::text[], false) -> 'new'
$$;

-- ===========================================================================
-- A-LM2: values derivable from masked ones (repro audit4-A/a7_mask.sql)
-- ===========================================================================
create temporary table t_credit as
select pg_temp.masked(jsonb_build_object('payload', jsonb_build_object(
         'total', 12000, 'credit_limit', 50000, 'balance', 45000,
         'exposure', 57000, 'credit_excess', 7000,
         'limit_metrics', jsonb_build_object('wf.decide.credit_limit', 7000, 'wf.decide.order_discount', 5)))) -> 'payload' as p;

select is((select p ->> 'exposure' from t_credit), '[masked:balance]',
  'A-LM2: exposure (= balance + total) is masked as a balance');
select is((select p ->> 'credit_excess' from t_credit), '[masked:credit_limit]',
  'A-LM2: credit_excess (= exposure - credit limit) is masked as a credit limit');
select is((select p -> 'limit_metrics' ->> 'wf.decide.credit_limit' from t_credit), '[masked:credit_limit]',
  'A-LM2: the credit limit metric (= credit_excess) stays masked');
select is((select (p ->> 'balance') || ' ' || (p ->> 'credit_limit') from t_credit), '[masked:balance] [masked:credit_limit]',
  'A-LM2: balance and credit limit stay masked');
select is((select (p ->> 'total') || ' ' || (p -> 'limit_metrics' ->> 'wf.decide.order_discount') from t_credit), '12000 5',
  'A-LM2: the order total and the discount metric stay readable');
select ok((select p::text !~ '(45000|50000|57000|7000)' from t_credit),
  'A-LM2: no number in the payload reveals the balance or the credit limit');

-- ===========================================================================
-- A-LM2: key casing and other spellings
-- ===========================================================================
create temporary table t_case as
select pg_temp.masked('{"Phone":"+201001234567","PHONE_PRIMARY":"+201112345678","tel":"+20100","Tel_Home":"+20101",
  "whatsapp":"+20111","WhatsApp_Number":"+20112","MOBILE_NO":"+20113","msisdn":"20114",
  "Latitude":30.04,"LONGITUDE":31.24,"Lat":30.1,"LNG":31.2,"GPS":"30.0,31.2","location":"30.04,31.24",
  "Email":"x@example.test","Unit_Cost":5,"Display_Name":"Clinic"}'::jsonb) as v;

select is((select v ->> 'Phone' from t_case), '[masked:phone]', 'A-LM2: Phone (mixed case) is masked');
select is((select v ->> 'PHONE_PRIMARY' from t_case), '[masked:phone]', 'A-LM2: PHONE_PRIMARY (upper case) is masked');
select is((select (v ->> 'tel') || ' ' || (v ->> 'Tel_Home') from t_case), '[masked:phone] [masked:phone]', 'A-LM2: tel and Tel_Home are masked');
select is((select (v ->> 'whatsapp') || ' ' || (v ->> 'WhatsApp_Number') from t_case), '[masked:phone] [masked:phone]',
  'A-LM2: whatsapp spellings are masked');
select is((select (v ->> 'MOBILE_NO') || ' ' || (v ->> 'msisdn') from t_case), '[masked:phone] [masked:phone]',
  'A-LM2: MOBILE_NO and msisdn are masked');
select is((select concat_ws(' ', v ->> 'Latitude', v ->> 'LONGITUDE', v ->> 'Lat', v ->> 'LNG') from t_case),
  '[masked:gps] [masked:gps] [masked:gps] [masked:gps]', 'A-LM2: Latitude / LONGITUDE / Lat / LNG are masked');
select is((select (v ->> 'GPS') || ' ' || (v ->> 'location') from t_case), '[masked:gps] [masked:gps]',
  'A-LM2: GPS and location strings are masked');
select is((select v ->> 'Email' from t_case), '[masked:email]', 'A-LM2: Email (mixed case) is masked');
select is((select v ->> 'Unit_Cost' from t_case), '[masked:cost]', 'A-LM2: Unit_Cost is masked for a reader without catalog.cost.read');
select is((select v ->> 'Display_Name' from t_case), 'Clinic', 'A-LM2: ordinary fields stay readable');

-- ===========================================================================
-- A-LM2: location containers, at any depth
-- ===========================================================================
create temporary table t_geo as
select audit.mask_jsonb(
  '{"geo":{"x":31.2,"y":30.0},
    "check_in":{"Location":{"lat":30.0,"lng":31.2},"coordinates":[31.2,30.0]},
    "stops":[{"Lat":30.1,"Lng":31.1,"name":"stop 1"},{"position":[31.3,30.3]}],
    "location_verified":true,"coordinator_id":"x","route":{"geometry":"LINESTRING(31 30, 31.1 30.1)"}}'::jsonb,
  (select jsonb_agg(jsonb_build_object('pattern', key_pattern, 'category', category, 'container_only', container_only)
                    order by category, key_pattern)
   from audit.row_image_masks)) as r;

select is((select r -> 'v' ->> 'geo' from t_geo), '[masked:gps]', 'A-LM2: a geo object is masked as a whole');
select is((select r -> 'v' -> 'check_in' ->> 'Location' from t_geo), '[masked:gps]', 'A-LM2: a nested Location object is masked');
select is((select r -> 'v' -> 'check_in' ->> 'coordinates' from t_geo), '[masked:gps]', 'A-LM2: a coordinates array is masked');
select is((select (r -> 'v' -> 'stops' -> 0 ->> 'Lat') || ' ' || (r -> 'v' -> 'stops' -> 0 ->> 'Lng') from t_geo),
  '[masked:gps] [masked:gps]', 'A-LM2: coordinates inside an array of objects are masked');
select is((select r -> 'v' -> 'stops' -> 0 ->> 'name' from t_geo), 'stop 1', 'A-LM2: their other fields stay readable');
select is((select r -> 'v' -> 'stops' -> 1 ->> 'position' from t_geo), '[masked:gps]', 'A-LM2: a position array is masked');
select is((select r -> 'v' -> 'route' ->> 'geometry' from t_geo), '[masked:gps]', 'A-LM2: a geometry string is masked');
select is((select (r -> 'v' ->> 'location_verified') || ' ' || (r -> 'v' ->> 'coordinator_id') from t_geo), 'true x',
  'A-LM2: container-only rules leave scalars such as location_verified readable');
select ok((select r -> 'm' @> '{"geo":"gps","check_in.Location":"gps","check_in.coordinates":"gps","stops[0].Lat":"gps","stops[1].position":"gps"}'
           from t_geo),
  'A-LM2: the masked map lists each hidden path');
select ok((select (r -> 'v')::text !~ '(30\.0|31\.2|30\.1|31\.1|31\.3)' from t_geo),
  'A-LM2: no coordinate survives anywhere in the image');

-- ===========================================================================
-- A-LM2: end to end through the reader, and reveal
-- ===========================================================================
insert into audit.audit_log (actor_user_id, action, table_schema, table_name, record_id, changed_fields, old_data, new_data)
values ('00000000-0000-0000-0000-0000000000a1', 'INSERT', 'wf', 'approval_requests', '99999999-0000-0000-0000-000000000052', null, null,
        jsonb_build_object('id', '99999999-0000-0000-0000-000000000052', 'payload', jsonb_build_object(
          'total', 12000, 'credit_limit', 50000, 'balance', 45000, 'exposure', 57000, 'credit_excess', 7000)));

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((select new_data -> 'payload' ->> 'exposure'
           from api.audit_record_history('wf', 'approval_requests', '99999999-0000-0000-0000-000000000052')),
  '[masked:balance]', 'A-LM2: the owner reading row images sees exposure masked by default');
select is((select masked ->> 'payload.credit_excess'
           from api.audit_record_history('wf', 'approval_requests', '99999999-0000-0000-0000-000000000052')),
  'credit_limit', 'A-LM2: the reader names credit_excess in the masked map');
select is((select (new_data -> 'payload' ->> 'exposure') || ' ' || (new_data -> 'payload' ->> 'credit_excess')
           from api.audit_record_history('wf', 'approval_requests', '99999999-0000-0000-0000-000000000052', p_reveal => true)),
  '57000 7000', 'A-LM2: an explicit reveal by an unmask holder shows them');
reset role;
select is((select details -> 'revealed' from audit.security_events
           where event_type = 'audit_row_image_read' and user_id = '00000000-0000-0000-0000-0000000000a1'
           order by id desc limit 1),
  '["balance", "credit_limit"]'::jsonb, 'A-LM2: the reveal is logged with its categories');

-- ===========================================================================
-- A-L4: catalogue, privileges
-- ===========================================================================
-- 20261104001100 added one export permission per kind; suite 54 pins the full export set.
select ok((select array_agg(code order by code) from authz.permissions where requires_mfa and code like '%.export')
          @> array['crm.customer.export', 'sales.order.export'], 'A-L4: both export permissions require MFA');
select is((select count(*)::int from authz.permissions where requires_mfa
             and code in ('crm.customer.read', 'sales.order.read', 'finance.invoice.read', 'finance.page.aging')),
  0, 'A-L4: list read permissions are not MFA-gated');
select ok((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'api' and p.proname in ('log_export', 'log_export_result')),
  'A-L4: both api functions are SECURITY DEFINER with search_path = ''''');
select ok(has_function_privilege('authenticated', 'api.log_export(text,jsonb,int,text)', 'execute')
          and has_function_privilege('authenticated', 'api.log_export_result(bigint,int,boolean,boolean)', 'execute'),
  'A-L4: authenticated may call them');
select ok(not has_function_privilege('anon', 'api.log_export(text,jsonb,int,text)', 'execute')
          and not has_function_privilege('anon', 'api.log_export_result(bigint,int,boolean,boolean)', 'execute')
          and not has_function_privilege('public', 'api.log_export(text,jsonb,int,text)', 'execute'),
  'A-L4: anon and PUBLIC may not');
select ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'audit' and p.proname in ('export_kinds', 'require_export')
                        and (p.prosecdef or has_function_privilege('authenticated', p.oid, 'execute')
                             or has_function_privilege('anon', p.oid, 'execute'))),
  'A-L4: the helpers are internal invoker functions');
select is((select count(*)::int
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute')
             and n.nspname in ('core','authz','catalog','inventory','crm','field','work','sales','finance','perf','wf','audit','notify','integration')
             and not exists (select 1 from pg_policies pol where coalesce(pol.qual,'') || ' ' || coalesce(pol.with_check,'') ~ ('\m' || p.proname || '\M'))
             and not exists (select 1 from pg_views v where v.definition ~ ('\m' || p.proname || '\M'))),
  0, 'A-L4: privilege sweep (suite 17) still holds');

-- ===========================================================================
-- A-L4: refusals
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.log_export('customers', '{}')$$, '42501', 'PERMISSION_DENIED: crm.customer.export',
  'A-L4: a rep without crm.customer.export cannot export customers');
select throws_ok($$select api.log_export('orders', '{}')$$, '42501', 'PERMISSION_DENIED: sales.order.export',
  'A-L4: a rep without sales.order.export cannot export orders');
select throws_ok($$select api.log_export('aging', '{}')$$, '42501', 'PERMISSION_DENIED: finance.page.aging',
  'A-L4: aging needs finance.page.aging or finance.ledger.read');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select throws_ok($$select api.log_export('salaries', '{}')$$, '22023', 'VALIDATION: unknown export kind salaries',
  'A-L4: a kind not on the whitelist is refused');
select throws_ok($$select api.log_export(null, '{}')$$, '22023', null, 'A-L4: a missing kind is refused');
select throws_ok($$select api.log_export('customers', '{"phone":"201001234567"}')$$, '22023', null,
  'A-L4: a filter key the kind does not have is refused');
select throws_ok($$select api.log_export('orders', '{"status":"Dr Ahmed Clinic"}')$$, '22023', null,
  'A-L4: a filter value that is not an id, code or date is refused');
select throws_ok($$select api.log_export('orders', '["status"]')$$, '22023', null, 'A-L4: filters must be an object');
select tests.authenticate_anon();
select throws_ok($$select api.log_export('orders', '{}')$$, '42501', null, 'A-L4: anon cannot log an export');

-- ===========================================================================
-- A-L4: happy path writes one event
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
create temporary table t_exp (id bigint);
grant select, insert on t_exp to authenticated;
insert into t_exp select api.log_export('customers', '{"q":"Dr Ahmed +201001234567","stage":"active","territory":null}', null, 'req-52-a');
reset role;
select is((select count(*)::int from audit.security_events where event_type = 'export' and user_id = '00000000-0000-0000-0000-0000000000a2'),
  1, 'A-L4: one export event for the user');
select is((select jsonb_build_object('user', user_id, 'severity', severity, 'kind', details ->> 'kind', 'filters', details -> 'filters',
                                     'rows', details -> 'rows', 'request_id', details ->> 'request_id')
           from audit.security_events where id = (select id from t_exp)),
  jsonb_build_object('user', '00000000-0000-0000-0000-0000000000a2', 'severity', 'info', 'kind', 'customers',
                     'filters', '{"q":"[redacted]","stage":"active"}'::jsonb, 'rows', null, 'request_id', 'req-52-a'),
  'A-L4: the event has the user, kind, filters (search redacted) and request id');
select ok((select details::text !~ '(Ahmed|201001234567)' from audit.security_events where id = (select id from t_exp)),
  'A-L4: the free-text search is not stored');
select is((select occurred_at from audit.security_events where id = (select id from t_exp)), now(),
  'A-L4: the event carries the request time');

-- The result row (final count)
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select lives_ok($$select api.log_export_result((select id from t_exp), 42, false, false)$$, 'A-L4: the exporter records the row count');
select throws_ok($$select api.log_export_result((select id from t_exp), 42, false, false)$$, 'P0001', null,
  'A-L4: the result is recorded once');
select throws_ok($$select api.log_export_result((select id from t_exp), -1, false, false)$$, '22023', null,
  'A-L4: a negative row count is refused');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_ok($$select api.log_export_result((select id from t_exp), 1, false, false)$$, 'P0002', null,
  'A-L4: another user cannot report on someone else''s export');
reset role;
select is((select details - 'export_id' from audit.security_events where event_type = 'export_result' and user_id = '00000000-0000-0000-0000-0000000000a2'),
  '{"kind":"customers","rows":42,"truncated":false,"failed":false}'::jsonb, 'A-L4: the result event has the kind and final count');

-- Alternatives: finance holds finance.page.aging; finance holds the invoice and aging export permissions.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try($$select api.log_export('aging', '{}')$$), 'OK', 'A-L4: finance may export aging');
select is(pg_temp.try($$select api.log_export('invoices', '{"status":"open","from":"2026-10-01","customer":"40000000-0000-0000-0000-000000000001"}')$$),
  'OK', 'A-L4: finance may export invoices with id, code and date filters');

-- ===========================================================================
-- A-L4: MFA step-up (security.mfa_enforced on)
-- ===========================================================================
reset role;
update core.system_settings set value = 'true'::jsonb where key = 'security.mfa_enforced';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(pg_temp.try($$select api.log_export('customers', '{}')$$), 'ERROR 42501 MFA_REQUIRED',
  'A-L4: MFA on, aal1: the customer export is refused');
select is(pg_temp.try($$select api.log_export('order_lines', '{}')$$), 'ERROR 42501 MFA_REQUIRED',
  'A-L4: MFA on, aal1: the order lines export is refused');
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a2');
select is(pg_temp.try($$select api.log_export('customers', '{}')$$), 'OK', 'A-L4: MFA on, aal2: the customer export is allowed');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(pg_temp.try($$select api.log_export('customers', '{}')$$), 'ERROR 42501 PERMISSION_DENIED',
  'A-L4: MFA on: a non-holder still sees PERMISSION_DENIED');
-- Since 20261104001100 every export kind is MFA-gated (suite 54 covers aal1 per kind).
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try($$select api.log_export('invoices', '{}')$$), 'OK',
  'A-L4: MFA on, aal2: finance may export invoices');
reset role;
update core.system_settings set value = 'false'::jsonb where key = 'security.mfa_enforced';

-- ===========================================================================
-- A-L4: rate limit (20 exports per user per 10 minutes)
-- ===========================================================================
-- Finance (a6) has 3 exports in the window so far (aging, invoices, invoices under MFA).
insert into audit.security_events (user_id, event_type, severity, details, occurred_at)
select '00000000-0000-0000-0000-0000000000a6', 'export', 'info', '{"kind":"invoices"}', now() - interval '11 minutes'
from generate_series(1, 30);
insert into audit.security_events (user_id, event_type, severity, details)
select '00000000-0000-0000-0000-0000000000a6', 'export_result', 'info', '{"kind":"invoices"}'
from generate_series(1, 30);
insert into audit.security_events (user_id, event_type, severity, details)
select '00000000-0000-0000-0000-0000000000a6', 'export', 'info', '{"kind":"invoices"}'
from generate_series(1, 16);
select is((select count(*)::int from audit.security_events where user_id = '00000000-0000-0000-0000-0000000000a6'
             and event_type = 'export' and occurred_at > now() - interval '10 minutes'),
  19, 'setup: finance has 19 exports in the window (older exports and results do not count)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try($$select api.log_export('invoices', '{}')$$), 'OK', 'A-L4: the 20th export in 10 minutes is allowed');
select throws_ok($$select api.log_export('invoices', '{}')$$, 'P0001', 'RATE_LIMITED: at most 20 exports per 10 minutes; try again later',
  'A-L4: the 21st export in 10 minutes is refused');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(pg_temp.try($$select api.log_export('orders', '{"status":"all"}')$$), 'OK',
  'A-L4: the limit is per user: another user may still export');

select * from finish();
rollback;
