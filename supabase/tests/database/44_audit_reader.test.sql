-- Audit row-image reader (migration 20261103001100_audit_row_image_reader.sql; security audit
-- 2026-10-29 #4 follow-up): owner-only access, field-level diffs, masking (cost by permission;
-- phones, emails, GPS, balances and credit limits by default), every read logged, and the
-- privilege rules (sweep, search_path, revokes) still holding.
begin;
select tests.load_fixture();
set constraints all immediate;
select plan(64);

-- Fixture: a1 owner · a4 rep Cairo · a6 finance (holds catalog.cost.read) · a7 admin (audit.log.read)
-- Customer 4…01 was inserted by the fixture (no actor). Give it two attributed changes by the owner.
do $$ begin perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000000a1')::text, true); end $$;
update crm.customers set display_name = 'Dr. Synthetic Clinic B', credit_limit = 5000, phone_primary = '+201000000009'
where id = '40000000-0000-0000-0000-000000000001';
update crm.customers set email = 'clinic.b@example.test', latitude = 30.050000, longitude = 31.240000
where id = '40000000-0000-0000-0000-000000000001';
update catalog.product_costs set unit_cost = 650 where variant_id = '53000000-0000-0000-0000-000000000001';
do $$ begin perform set_config('request.jwt.claims', '', true); end $$;

create temporary table t_ids as
select (select id::text from catalog.product_costs where variant_id = '53000000-0000-0000-0000-000000000001') as cost_id;
grant select on t_ids to authenticated;

-- ===========================================================================
-- Privileges: search_path, definer, revokes, sweep
-- ===========================================================================
select ok(
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'api' and p.proname in ('audit_search', 'audit_record_history', 'audit_tables')),
  'the three api functions are SECURITY DEFINER with search_path = ''''');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'audit' and p.proname in ('mask_jsonb', 'mask_entry', 'read_row_images', 'require_row_image_reader')
     and not p.prosecdef and p.proconfig @> array['search_path=""']),
  4, 'internal helpers are invoker functions with search_path = ''''');
select ok(
  has_function_privilege('authenticated', 'api.audit_search(text,text,text,uuid,date,date,text,bigint,int,boolean)', 'execute')
  and has_function_privilege('authenticated', 'api.audit_record_history(text,text,text,bigint,int,boolean)', 'execute')
  and has_function_privilege('authenticated', 'api.audit_tables()', 'execute'),
  'authenticated may call the reader (the function itself decides)');
select ok(
  not has_function_privilege('anon', 'api.audit_search(text,text,text,uuid,date,date,text,bigint,int,boolean)', 'execute')
  and not has_function_privilege('anon', 'api.audit_record_history(text,text,text,bigint,int,boolean)', 'execute')
  and not has_function_privilege('anon', 'api.audit_tables()', 'execute'),
  'anon cannot call the reader');
select ok(
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'audit' and p.proname in ('mask_jsonb', 'mask_entry', 'read_row_images', 'require_row_image_reader')
                and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))),
  'internal helpers are not client-callable');
select is((select count(*)::int
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute')
             and n.nspname in ('core','authz','catalog','inventory','crm','field','work','sales','finance','perf','wf','audit','notify','integration')
             and not exists (select 1 from pg_policies pol where coalesce(pol.qual,'') || ' ' || coalesce(pol.with_check,'') ~ ('\m' || p.proname || '\M'))
             and not exists (select 1 from pg_views v where v.definition ~ ('\m' || p.proname || '\M'))),
         0, 'privilege sweep (suite 17) still holds');
select ok(not has_column_privilege('authenticated', 'audit.audit_log', 'old_data', 'select')
          and not has_column_privilege('authenticated', 'audit.audit_log', 'new_data', 'select'),
  'row-image columns stay ungranted (#4)');
select ok((select relrowsecurity from pg_class where oid = 'audit.row_image_masks'::regclass), 'mask list has RLS enabled');
select ok(not has_table_privilege('authenticated', 'audit.row_image_masks', 'insert')
          and not has_table_privilege('authenticated', 'audit.row_image_masks', 'update')
          and not has_table_privilege('authenticated', 'audit.row_image_masks', 'delete'),
  'mask list has no client write grants');
select is((select array_agg(code order by code) from authz.permissions where code like 'audit.row_image.%'),
          array['audit.row_image.read', 'audit.row_image.unmask'], 'both permissions are catalogued');
select ok((select bool_and(is_sensitive and allowed_scopes = '{all}') from authz.permissions where code like 'audit.row_image.%'),
  'both permissions are sensitive and company-wide only');
select is((select count(*)::int from authz.role_permissions where permission_code like 'audit.row_image.%'), 0,
  'no role holds them: only owners (implicitly) read row images');

-- ===========================================================================
-- Non-owners are denied
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select throws_ok($$select * from api.audit_search()$$, '42501', 'PERMISSION_DENIED: audit.row_image.read',
  'an admin with audit.log.read cannot search row images');
select throws_ok($$select * from api.audit_record_history('crm', 'customers', '40000000-0000-0000-0000-000000000001')$$,
  '42501', 'PERMISSION_DENIED: audit.row_image.read', 'an admin cannot read a record history');
select throws_ok($$select * from api.audit_tables()$$, '42501', 'PERMISSION_DENIED: audit.row_image.read',
  'an admin cannot list audited tables through the reader');
select throws_ok($$select old_data from audit.audit_log limit 1$$, '42501', null, 'an admin still cannot select row images directly');
select is((select count(*)::int from audit.row_image_masks), 0, 'an admin cannot read the mask list');
select throws_like($$select api.set_role_permission((select id from authz.roles where code = 'admin'), 'audit.row_image.read', 'all')$$,
  'ESCALATION_BLOCKED%', 'an admin cannot grant itself the reader (grant ceiling)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select * from api.audit_search()$$, '42501', null, 'a sales rep is denied');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_ok($$select * from api.audit_record_history('catalog', 'product_costs', (select cost_id from t_ids))$$, '42501', null,
  'finance (holds catalog.cost.read) is still denied without the reader permission');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a9');
select throws_ok($$select * from api.audit_search()$$, '42501', null, 'a user without a profile is denied');

-- ===========================================================================
-- The owner sees diffs
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
create temporary table t_hist as
select * from api.audit_record_history('crm', 'customers', '40000000-0000-0000-0000-000000000001');
select is((select array_agg(action order by id) from t_hist), array['INSERT', 'UPDATE', 'UPDATE'],
  'owner: the record timeline has the insert and both updates');
select is((select id from t_hist limit 1), (select max(id) from t_hist), 'owner: newest entry first');
select is((select changed_fields from t_hist where action = 'UPDATE' order by id limit 1),
          array['credit_limit', 'display_name', 'phone_primary']::text[], 'owner: changed fields of the first update');
select is((select old_data ->> 'display_name' || ' -> ' || (new_data ->> 'display_name') from t_hist where action = 'UPDATE' order by id limit 1),
          'Dr. Ahmed Clinic -> Dr. Synthetic Clinic B', 'owner: old and new values of a plain field (diff)');
select is((select actor_user_id from t_hist where action = 'UPDATE' order by id limit 1), '00000000-0000-0000-0000-0000000000a1'::uuid,
  'owner: the actor is attributed');
select is((select actor_name_en from t_hist where action = 'UPDATE' order by id limit 1), 'Owner', 'owner: the actor name is joined');
select is((select actor_user_id from t_hist where action = 'INSERT'), null::uuid, 'owner: a system insert has no actor');

-- ===========================================================================
-- Masking: default-masked categories for the owner
-- ===========================================================================
select is((select new_data ->> 'phone_primary' from t_hist where action = 'UPDATE' order by id limit 1), '[masked:phone]',
  'masked: phone (new value)');
select is((select old_data ->> 'phone_primary' from t_hist where action = 'UPDATE' order by id limit 1), '[masked:phone]',
  'masked: phone (old value)');
select is((select new_data ->> 'credit_limit' from t_hist where action = 'UPDATE' order by id limit 1), '[masked:credit_limit]',
  'masked: credit limit');
select is((select new_data ->> 'email' from t_hist where action = 'UPDATE' order by id desc limit 1), '[masked:email]', 'masked: email');
select is((select (new_data ->> 'latitude') || ',' || (new_data ->> 'longitude') from t_hist order by id desc limit 1),
          '[masked:gps],[masked:gps]', 'masked: GPS coordinates');
select is((select masked from t_hist where action = 'UPDATE' order by id limit 1),
          '{"phone_primary":"phone","credit_limit":"credit_limit","latitude":"gps","longitude":"gps"}'::jsonb,
          'masked: the masked map names each hidden field and its category (null fields are not listed)');
select is((select old_data -> 'email' from t_hist where action = 'UPDATE' order by id desc limit 1), 'null'::jsonb,
  'masked: an empty value stays empty');
select is((select new_data ->> 'display_name' from t_hist order by id desc limit 1), 'Dr. Synthetic Clinic B',
  'masked: ordinary fields are untouched');
select is((select new_data ->> 'unit_cost' from api.audit_record_history('catalog', 'product_costs', (select cost_id from t_ids)) limit 1),
          '650.00', 'owner holds catalog.cost.read: cost is visible');

-- Reveal (owner holds audit.row_image.unmask implicitly)
select is((select new_data ->> 'phone_primary'
           from api.audit_record_history('crm', 'customers', '40000000-0000-0000-0000-000000000001', p_reveal => true)
           where action = 'UPDATE' order by id limit 1),
          '+201000000009', 'reveal: the owner sees the phone when asking explicitly');
select is((select details -> 'revealed' from audit.security_events where event_type = 'audit_row_image_read' order by id desc limit 1),
          '["credit_limit", "email", "gps", "phone"]'::jsonb, 'reveal: the log lists the revealed categories');
select is((select severity from audit.security_events where event_type = 'audit_row_image_read' order by id desc limit 1),
          'warning', 'reveal: a reveal is logged as a warning');

-- Nested keys (approval payloads carry credit_limit and balance)
select tests.clear_authentication();
select is(audit.mask_jsonb('{"total": 10, "credit_limit": 5, "lines": [{"balance": 3, "qty": 1}]}',
                           '[{"pattern": "%credit\\_limit%", "category": "credit_limit"}, {"pattern": "%balance%", "category": "balance"}]'),
          '{"v": {"total": 10, "credit_limit": "[masked:credit_limit]", "lines": [{"balance": "[masked:balance]", "qty": 1}]},
            "m": {"credit_limit": "credit_limit", "lines[0].balance": "balance"}}'::jsonb,
          'nested: keys are masked at any depth, with their paths');

-- ===========================================================================
-- Masking lifts with the permission (a delegated, non-owner reader)
-- ===========================================================================
insert into authz.user_permission_overrides (user_id, permission_code, effect, scope, reason) values
  ('00000000-0000-0000-0000-0000000000a7', 'audit.row_image.read', 'grant', 'team', 'synthetic test: wrong scope');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select throws_ok($$select * from api.audit_search()$$, '42501', 'PERMISSION_DENIED: audit.row_image.read requires scope all',
  'scope: a team-scoped grant does not read row images');
select tests.clear_authentication();
insert into authz.user_permission_overrides (user_id, permission_code, effect, scope, reason) values
  ('00000000-0000-0000-0000-0000000000a7', 'audit.row_image.read', 'grant', 'all', 'synthetic test: delegated auditor');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is((select new_data ->> 'unit_cost' from api.audit_record_history('catalog', 'product_costs', (select cost_id from t_ids)) limit 1),
          '[masked:cost]', 'delegated reader without catalog.cost.read: cost is masked');
select is((select masked from api.audit_record_history('catalog', 'product_costs', (select cost_id from t_ids)) limit 1),
          '{"unit_cost": "cost"}'::jsonb, 'delegated reader: the masked map names the cost');
select is((select new_data ->> 'phone_primary'
           from api.audit_record_history('crm', 'customers', '40000000-0000-0000-0000-000000000001', p_reveal => true)
           where action = 'UPDATE' order by id limit 1),
          '[masked:phone]', 'delegated reader: asking to reveal without audit.row_image.unmask changes nothing');
select is((select details -> 'revealed' from audit.security_events where event_type = 'audit_row_image_read' order by id desc limit 1),
          '[]'::jsonb, 'delegated reader: nothing revealed, nothing listed');
select tests.clear_authentication();
insert into authz.user_permission_overrides (user_id, permission_code, effect, scope, reason) values
  ('00000000-0000-0000-0000-0000000000a7', 'catalog.cost.read', 'grant', 'all', 'synthetic test'),
  ('00000000-0000-0000-0000-0000000000a7', 'audit.row_image.unmask', 'grant', 'all', 'synthetic test');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is((select new_data ->> 'unit_cost' from api.audit_record_history('catalog', 'product_costs', (select cost_id from t_ids)) limit 1),
          '650.00', 'with catalog.cost.read: cost is unmasked (no reveal needed)');
select is((select new_data ->> 'phone_primary'
           from api.audit_record_history('crm', 'customers', '40000000-0000-0000-0000-000000000001')
           where action = 'UPDATE' order by id limit 1),
          '[masked:phone]', 'with audit.row_image.unmask: phones stay masked by default');
select is((select new_data ->> 'phone_primary'
           from api.audit_record_history('crm', 'customers', '40000000-0000-0000-0000-000000000001', p_reveal => true)
           where action = 'UPDATE' order by id limit 1),
          '+201000000009', 'with audit.row_image.unmask and reveal: the phone is shown');
select is((select count(*)::int from audit.row_image_masks) > 0, true, 'a reader can see the mask list');

-- ===========================================================================
-- Access is logged
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
create temporary table t_before as select count(*)::int as n from audit.security_events where event_type = 'audit_row_image_read';
select is((select count(*)::int from api.audit_record_history('crm', 'customers', '40000000-0000-0000-0000-000000000001')), 3,
  'log: a history read');
select is((select count(*)::int from audit.security_events where event_type = 'audit_row_image_read') - (select n from t_before), 1,
  'log: exactly one security event per call');
select is((select user_id::text || ' ' || (details ->> 'function') || ' ' || (details #>> '{filters,table_schema}') || '.'
                  || (details #>> '{filters,table_name}') || ' ' || (details #>> '{filters,record_id}') || ' rows=' || (details ->> 'rows')
           from audit.security_events where event_type = 'audit_row_image_read' order by id desc limit 1),
          '00000000-0000-0000-0000-0000000000a1 audit_record_history crm.customers 40000000-0000-0000-0000-000000000001 rows=3',
          'log: who looked at which record, and how many entries');
select is((select severity from audit.security_events where event_type = 'audit_row_image_read' order by id desc limit 1), 'info',
  'log: a masked read is info');
select is((select count(*)::int from api.audit_tables() where table_schema = 'crm' and table_name = 'customers'), 1,
  'audit_tables lists audited tables');
select is((select count(*)::int from audit.security_events where event_type = 'audit_row_image_read') - (select n from t_before), 1,
  'log: listing tables is metadata only and is not logged');

-- ===========================================================================
-- Search filters
-- ===========================================================================
select is((select count(*)::int from api.audit_search(p_table_schema => 'crm', p_table_name => 'customers',
                                                      p_actor_user_id => '00000000-0000-0000-0000-0000000000a1')), 2,
  'search: by table and actor');
select is((select count(*)::int from api.audit_search(p_record_id => '40000000-0000-0000-0000-000000000001', p_action => 'insert')), 1,
  'search: by record id and action (case-insensitive)');
select is((select count(*)::int from api.audit_search(p_table_schema => 'crm', p_table_name => 'customers',
                                                      p_from => core.business_date(), p_to => core.business_date())), 4,
  'search: today (Cairo) includes today''s changes');
select is((select count(*)::int from api.audit_search(p_table_schema => 'crm', p_table_name => 'customers',
                                                      p_to => core.business_date() - 1)), 0,
  'search: a range ending yesterday excludes them');
select is((select count(*)::int from api.audit_search(p_table_schema => 'crm', p_table_name => 'customers', p_limit => 1,
                                                      p_before_id => (select max(id) from t_hist))), 1,
  'search: keyset paging with before_id and limit');
select throws_ok($$select * from api.audit_search(p_action => 'TRUNCATE')$$, '22023', null, 'search: an unknown action is a validation error');
select throws_ok($$select * from api.audit_search(p_from => '2026-10-02', p_to => '2026-10-01')$$, '22023', null,
  'search: a reversed date range is a validation error');
select throws_ok($$select * from api.audit_record_history('crm', 'customers', '  ')$$, '22023', null,
  'history: a record id is required');

select tests.clear_authentication();
select * from finish();
rollback;
