-- Audit 4, MFA step-up gaps (20261104000300_audit4_mfa_gated_set.sql):
--   A-M1  quarantine release goes through the MFA check on the real command path
--         (api.create_transfer / api.receive_transfer → inventory.assert_quarantine_release)
--   set   admin.settings.manage, admin.workflow.manage, audit.row_image.unmask,
--         wf.decide.write_off, sales.return.credit, perf.commission.calculate and
--         inventory.quarantine.release require MFA once security.mfa_enforced is on
--   paths audit.row_image.unmask (reveal in the audit reader) and wf.decide.* (api.decide_approval)
--         are not exercised through authz.require, so they call authz.require_mfa themselves
--   M-5   the manual commission close needs aal2; the cron (service_role, no aal claim) still
--         closes months with enforcement on
--   off   with the switch off nothing changes
--   users: a1 owner · a3 area mgr (+ synthetic transfer role) · a6 finance officer · a7 admin
--          · a8 inventory manager
begin;
select tests.load_fixture();
select plan(65);
set constraints all immediate;

-- Runs a statement; returns its text result, 'OK' for no value, or 'ERROR <sqlstate> <CODE>'.
create function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare r text;
begin
  execute p_sql into r;
  return coalesce(nullif(r, ''), 'OK');
exception when others then
  return 'ERROR ' || sqlstate || ' ' || split_part(sqlerrm, ':', 1);
end $$;

-- authz.require(perm) for a user with the given aal claim (NULL = no claim). Leaves no claims behind.
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

create function pg_temp.cm(k int) returns date language sql stable as $$
  select (date_trunc('month', core.business_date()) + make_interval(months => k))::date $$;

create function pg_temp.wo_req(p_key text) returns uuid language sql as $$
  select r.id from wf.approval_requests r join wf.workflow_definitions d on d.id = r.definition_id
  where d.code = 'finance.write_off' and r.payload ->> 'idempotency_key' = p_key $$;

grant execute on all functions in schema pg_temp to authenticated;

create temp table gated (code text primary key) on commit drop;
insert into gated values
  ('admin.settings.manage'), ('admin.workflow.manage'), ('audit.row_image.unmask'), ('wf.decide.write_off'),
  ('sales.return.credit'), ('perf.commission.calculate'), ('inventory.quarantine.release');
grant select on gated to authenticated;

-- ---------------------------------------------------------------------------
-- Setup (schema owner). Synthetic data only.
--   WH-Q48 quarantine warehouse with 5 units of L2026A · a transfer-only role for a3
--   INV-T48 open invoice of C-0001 · an open commission month three months ago
-- ---------------------------------------------------------------------------
insert into inventory.warehouses (id, code, name, kind) values
  ('48a00000-0000-0000-0000-000000000001', 'WH-Q48', 'Synthetic quarantine 48', 'quarantine');
insert into authz.roles (id, code, name_en, name_ar) values
  ('48b00000-0000-0000-0000-000000000001', 't48_mover', 'Test stock mover', 'ناقل مخزون تجريبي');
insert into authz.role_permissions (role_id, permission_code, scope) values
  ('48b00000-0000-0000-0000-000000000001', 'inventory.transfer.create', 'all');
insert into authz.user_roles (user_id, role_id) values
  ('00000000-0000-0000-0000-0000000000a3', '48b00000-0000-0000-0000-000000000001');

insert into finance.invoices (id, invoice_no, customer_id, issue_date, due_date, status, subtotal, discount_total, tax_total, total)
values ('48d00000-0000-0000-0000-000000000001', 'INV-T48', '40000000-0000-0000-0000-000000000001',
        core.business_date() - 60, core.business_date() - 30, 'issued', 100, 0, 14, 114);
insert into finance.customer_ledger (customer_id, entry_type, amount, source_table, source_id)
values ('40000000-0000-0000-0000-000000000001', 'invoice', 114, 'finance.invoices', '48d00000-0000-0000-0000-000000000001');

insert into perf.commission_periods (period_start, period_end)
values (pg_temp.cm(-3), (pg_temp.cm(-2) - 1));

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select api.post_goods_receipt((api.create_goods_receipt('48a00000-0000-0000-0000-000000000001', 'Returned by clinic (synthetic)', 'SHP-T48',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_no":"L2026A","expiry_date":"2030-12-31","quantity":5}]'::jsonb)
  ->> 'receipt_id')::uuid) is not null as stocked;
select tests.clear_authentication();

-- ===========================================================================
-- The gated set
-- ===========================================================================
select is((select count(*)::int from authz.permissions p join gated g using (code)), 7,
          'every permission of the new gated set exists under its exact code');
select is((select count(*)::int from authz.permissions p join gated g using (code) where p.requires_mfa), 7,
          'every permission of the new gated set requires MFA');
select is((select array_agg(code order by code) from authz.permissions where requires_mfa and code <> 'admin.import.run'),
          array['admin.override.manage','admin.role.assign','admin.role.manage','admin.settings.manage',
                'admin.user.suspend','admin.workflow.manage','audit.row_image.unmask','catalog.price.manage',
                'crm.customer.export','field.tracking.export','field.visit.export','finance.aging.export',
                'finance.credit_limit.change','finance.invoice.export','finance.payment.export','finance.payment.reverse',
                'inventory.quarantine.release','inventory.stock.export',
                'perf.commission.calculate','sales.order.export','sales.return.credit','wf.decide.write_off'],
          'the full gated set (admin.import.run too, once it exists; exports gated by 20261104000710 and 20261104001100)');
select ok((select bool_and(p.is_sensitive) from authz.permissions p where p.requires_mfa),
          'every gated permission is also marked sensitive');
select is((select requires_mfa from api.v_permissions where code = 'perf.commission.calculate'), true,
          'the catalogue view shows the new flag');
select is((select value from core.system_settings where key = 'security.mfa_enforced'), 'false'::jsonb,
          'security.mfa_enforced still ships false');
select ok(not has_function_privilege('authenticated', 'inventory.assert_quarantine_release(uuid,uuid)', 'execute')
          and not has_function_privilege('authenticated', 'audit.read_row_images(text,jsonb,text,text,text,uuid,date,date,text,bigint,int,boolean)', 'execute'),
          'the redefined internal helpers stay internal');
select ok(has_function_privilege('authenticated', 'api.decide_approval(uuid,text,text)', 'execute')
          and not has_function_privilege('anon', 'api.decide_approval(uuid,text,text)', 'execute'),
          'decide_approval keeps its privileges');

-- ===========================================================================
-- Enforcement OFF: unchanged
-- ===========================================================================
select is((select count(*)::int from gated g where pg_temp.req('00000000-0000-0000-0000-0000000000a1', 'aal1', g.code) = 'OK'), 7,
          'off: the owner exercises every newly gated permission at aal1');
select is(pg_temp.req('00000000-0000-0000-0000-0000000000a6', null, 'perf.commission.calculate'), 'OK',
          'off: finance calculates commissions without an aal claim');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(pg_temp.try($$select api.create_transfer('48a00000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001',
            '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_id":"61000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb) ->> 'status'$$),
          'draft', 'off: the inventory manager releases quarantine stock at aal1 (create)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try($$select (api.calculate_commission_period(core.business_date()) ->> 'frozen')$$), 'false',
          'off: finance recalculates the open month at aal1');
select is(pg_temp.try($$select api.credit_return(gen_random_uuid(), 'k-48-off')$$), 'ERROR P0002 NOT_FOUND',
          'off: finance passes the return-credit gate at aal1 (unknown return)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is(pg_temp.try($$select api.upsert_workflow_rule('finance.write_off', 50)$$), 'ERROR P0001 REASON_REQUIRED',
          'off: the admin passes the workflow gate at aal1');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(pg_temp.try($$select count(*)::text from api.audit_search(p_limit => 1, p_reveal => true)$$), '1',
          'off: the owner reveals audit row images at aal1');
select tests.clear_authentication();

-- ===========================================================================
-- Enforcement ON
-- ===========================================================================
select pg_temp.enforce(true);

-- ---- authz.require for each newly gated permission ----
select is((select count(*)::int from gated g
            where pg_temp.req('00000000-0000-0000-0000-0000000000a1', 'aal1', g.code) = 'ERROR 42501 MFA_REQUIRED'), 7,
          'on: the owner at aal1 is refused every newly gated permission');
select is((select count(*)::int from gated g where pg_temp.req('00000000-0000-0000-0000-0000000000a1', 'aal2', g.code) = 'OK'), 7,
          'on: the owner at aal2 exercises every newly gated permission');
select is(pg_temp.req('00000000-0000-0000-0000-0000000000a4', 'aal1', 'perf.commission.calculate'), 'ERROR 42501 PERMISSION_DENIED',
          'on: a non-holder still gets PERMISSION_DENIED, not MFA_REQUIRED');
select is(pg_temp.req('00000000-0000-0000-0000-0000000000a6', 'aal1', 'perf.commission.read'), 'OK',
          'on: a non-gated neighbour permission is unaffected at aal1');

-- ---- A-M1: quarantine release through the real commands ----
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(pg_temp.try($$select api.create_transfer('48a00000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001',
            '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_id":"61000000-0000-0000-0000-000000000001","quantity":5}]'::jsonb) ->> 'status'$$),
          'ERROR 42501 MFA_REQUIRED', 'on: the inventory manager at aal1 cannot create a release transfer');
select is((select count(*)::int from inventory.transfers where from_warehouse_id = '48a00000-0000-0000-0000-000000000001'), 1,
          'on: the refused release created no transfer (only the earlier one exists)');
select is(pg_temp.try($$select api.create_transfer('60000000-0000-0000-0000-000000000001', '48a00000-0000-0000-0000-000000000001',
            '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_id":"61000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb) ->> 'status'$$),
          'draft', 'on: moving stock INTO quarantine needs no second factor');
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a8');
select set_config('t48.tr', pg_temp.try($$select api.create_transfer('48a00000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001',
            '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_id":"61000000-0000-0000-0000-000000000001","quantity":4}]'::jsonb) ->> 'transfer_id'$$), true) is not null as release_transfer;
select ok(current_setting('t48.tr') ~ '^[0-9a-f-]{36}$', 'on: the inventory manager at aal2 creates the release transfer');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(pg_temp.try(format($$select api.ship_transfer(%L) ->> 'status'$$, current_setting('t48.tr'))), 'in_transit',
          'on: shipping is not the release; it works at aal1');
select is(pg_temp.try(format($$select api.receive_transfer(%L) ->> 'status'$$, current_setting('t48.tr'))),
          'ERROR 42501 MFA_REQUIRED', 'on: receiving released stock at aal1 is refused (the moment it becomes sellable)');
select is((select status from inventory.transfers where id = current_setting('t48.tr')::uuid), 'in_transit',
          'on: the refused receipt changed nothing');
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a8');
select is(pg_temp.try(format($$select api.receive_transfer(%L) ->> 'status'$$, current_setting('t48.tr'))), 'received',
          'on: the inventory manager at aal2 receives the released stock');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(pg_temp.try($$select api.create_transfer('48a00000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001',
            '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_id":"61000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb) ->> 'status'$$),
          'ERROR 42501 PERMISSION_DENIED', 'on: a transfer creator without the release permission is denied, not asked for MFA');
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a3');
select is(pg_temp.try($$select api.create_transfer('48a00000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001',
            '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_id":"61000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb) ->> 'status'$$),
          'ERROR 42501 PERMISSION_DENIED', 'on: aal2 grants no release by itself');

-- ---- admin.settings.manage ----
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is(pg_temp.try($$select api.update_setting('field.geofence_radius_m', '200'::jsonb, 'synthetic test 48') ->> 'changed'$$),
          'ERROR 42501 MFA_REQUIRED', 'on: the admin at aal1 cannot change a setting');
select is((select value from core.system_settings where key = 'field.geofence_radius_m'), '150'::jsonb,
          'on: the refused change left the setting alone');
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a7');
select is(pg_temp.try($$select api.update_setting('field.geofence_radius_m', '200'::jsonb, 'synthetic test 48') ->> 'changed'$$),
          'true', 'on: the admin at aal2 changes a setting');

-- ---- admin.workflow.manage ----
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is(pg_temp.try($$select api.upsert_workflow_rule('finance.write_off', 50)$$), 'ERROR 42501 MFA_REQUIRED',
          'on: the admin at aal1 cannot change a workflow');
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a7');
select is(pg_temp.try($$select api.upsert_workflow_rule('finance.write_off', 50)$$), 'ERROR P0001 REASON_REQUIRED',
          'on: the admin at aal2 passes the workflow gate');

-- ---- sales.return.credit ----
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try($$select api.credit_return(gen_random_uuid(), 'k-48-on')$$), 'ERROR 42501 MFA_REQUIRED',
          'on: finance at aal1 cannot credit a return');
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try($$select api.credit_return(gen_random_uuid(), 'k-48-on')$$), 'ERROR P0002 NOT_FOUND',
          'on: finance at aal2 passes the return-credit gate (unknown return)');

-- ---- audit.row_image.unmask (the reveal in the audit reader) ----
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(pg_temp.try($$select count(*)::text from api.audit_search(p_limit => 1, p_reveal => true)$$), 'ERROR 42501 MFA_REQUIRED',
          'on: the owner at aal1 cannot reveal masked values');
select is(pg_temp.try($$select count(*)::text from api.audit_record_history('finance', 'invoices', '48d00000-0000-0000-0000-000000000001', p_reveal => true)$$),
          'ERROR 42501 MFA_REQUIRED', 'on: the record history reveal is gated too');
select is(pg_temp.try($$select count(*)::text from api.audit_search(p_limit => 1)$$), '1',
          'on: the owner at aal1 still reads masked row images');
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a1');
select is(pg_temp.try($$select count(*)::text from api.audit_search(p_limit => 1, p_reveal => true)$$), '1',
          'on: the owner at aal2 reveals masked values');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try($$select count(*)::text from api.audit_search(p_limit => 1, p_reveal => true)$$), 'ERROR 42501 PERMISSION_DENIED',
          'on: a non-reader is denied, never asked for MFA');
select tests.clear_authentication();
select is((select count(*)::int from audit.security_events where event_type = 'audit_row_image_read'
            and (details ->> 'reveal_requested')::boolean and user_id = '00000000-0000-0000-0000-0000000000a1'), 2,
          'only the allowed reveals (off at aal1, on at aal2) were logged; refused ones rolled back');

-- ---- wf.decide.write_off (api.decide_approval) ----
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(pg_temp.try($$select api.request_invoice_write_off('48d00000-0000-0000-0000-000000000001', 114, 'clinic closed (synthetic)', 'wo-48-1') ->> 'status'$$),
          'pending_approval', 'on: the owner requests a write-off (requesting is not gated)');
select tests.clear_authentication();
select set_config('t48.wo', pg_temp.wo_req('wo-48-1')::text, true) is not null as wo_request;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try(format($$select api.decide_approval(%L, 'approve') ->> 'status'$$, current_setting('t48.wo'))),
          'ERROR 42501 MFA_REQUIRED', 'on: finance at aal1 cannot decide a write-off');
select is(pg_temp.try(format($$select api.decide_approval(%L, 'reject', 'no') ->> 'status'$$, current_setting('t48.wo'))),
          'ERROR 42501 MFA_REQUIRED', 'on: rejecting is a decision too');
select is((select status from wf.approval_requests where id = current_setting('t48.wo')::uuid), 'pending',
          'on: the refused decision left the request pending');
select is((select count(*)::int from wf.approval_steps where request_id = current_setting('t48.wo')::uuid), 0,
          'on: the refused decision recorded no step');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(pg_temp.try(format($$select api.decide_approval(%L, 'approve') ->> 'status'$$, current_setting('t48.wo'))),
          'ERROR 42501 PERMISSION_DENIED', 'on: a non-approver is denied, not asked for MFA');
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try(format($$select api.decide_approval(%L, 'approve') ->> 'status'$$, current_setting('t48.wo'))),
          'approved', 'on: finance at aal2 approves the write-off');
select is((select status from finance.invoices where id = '48d00000-0000-0000-0000-000000000001'), 'written_off',
          'on: the approved write-off was posted by the hook');
select tests.clear_authentication();

-- ---- M-5: the manual commission close and the cron ----
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try($$select api.close_commission_period(pg_temp.cm(-3)) ->> 'status'$$), 'ERROR 42501 MFA_REQUIRED',
          'on: finance at aal1 cannot close a commission month');
select is(pg_temp.try($$select api.calculate_commission_period(core.business_date()) ->> 'frozen'$$), 'ERROR 42501 MFA_REQUIRED',
          'on: finance at aal1 cannot recalculate either (same permission)');
select is((select status from perf.commission_periods where period_start = pg_temp.cm(-3)), 'open',
          'on: the refused close changed nothing');
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try($$select api.close_commission_period(pg_temp.cm(-3)) ->> 'status'$$), 'approved',
          'on: finance at aal2 closes the month');
select is((select approved_by from perf.commission_periods where period_start = pg_temp.cm(-3)),
          '00000000-0000-0000-0000-0000000000a6'::uuid, 'on: the manual close records the person');
select tests.clear_authentication();

-- the cron: service_role, no aal claim at all
select set_config('request.jwt.claims', '{"role":"service_role"}', true) is not null as cron_claims;
set local role service_role;
select is((select current_setting('request.jwt.claims')::jsonb ? 'aal'), false, 'the cron session carries no aal claim');
select lives_ok($$select service.commission_run()$$, 'on: the cron runs with enforcement on');
reset role;
select set_config('request.jwt.claims', '', true) is not null as cleared;
select is((select status from perf.commission_periods where period_start = pg_temp.cm(-2)), 'approved',
          'on: the cron closed the next month whose close date passed');
select is((select approved_by from perf.commission_periods where period_start = pg_temp.cm(-2)), null,
          'on: a cron close records no person (the automatic freeze is the approval)');
select is((select count(*)::int from perf.commission_periods p
            where not perf.commission_status_frozen(p.status) and perf.period_close_at(p.period_start) <= now()), 0,
          'on: no month whose close date passed is left open');

-- ---- my_mfa_status lists the new gates ----
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select ok((api.my_mfa_status() -> 'required_permissions') @> '["perf.commission.calculate","sales.return.credit","wf.decide.write_off"]'::jsonb,
          'on: finance sees its newly gated permissions on the account page');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is((api.my_mfa_status() -> 'required_permissions'), '["inventory.quarantine.release","inventory.stock.export"]'::jsonb,
          'on: the inventory manager sees the quarantine gate (and the stock export gate, 20261104001100)');
select tests.clear_authentication();

-- ===========================================================================
-- Switching off again restores the old behaviour at once
-- ===========================================================================
select pg_temp.enforce(false);
select is((select count(*)::int from unnest(array['perf.commission.calculate','sales.return.credit','wf.decide.write_off']) g(code)
            where pg_temp.req('00000000-0000-0000-0000-0000000000a6', 'aal1', g.code) = 'OK'), 3,
          'off again: finance exercises its newly gated permissions at aal1');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(pg_temp.try($$select api.create_transfer('48a00000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001',
            '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_id":"61000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb) ->> 'status'$$),
          'draft', 'off again: the inventory manager releases at aal1');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(pg_temp.try($$select count(*)::text from api.audit_search(p_limit => 1, p_reveal => true)$$), '1',
          'off again: the owner reveals at aal1');
select tests.clear_authentication();

select * from finish();
rollback;
