-- Honest OS migration: audit 4 (money and stock) fixes M-2 and M-3 (orders half).
--
-- M-2 · Two concurrent imports could load the same opening stock or opening AR twice.
--   Nothing serialized commits of DIFFERENT batches: api.import_commit locked only its own batch row,
--   and both sessions' re-validation ran before either had committed, so both passed the
--   "already imported" checks and both posted (two opening balances for one customer; two receipts
--   of the same opening lot).
--   Fix:
--   * api.import_commit takes pg_advisory_xact_lock(hashtextextended('import.commit:' || kind, 0))
--     after the batch lock and state checks and BEFORE the re-validation, so the "already imported"
--     checks of import._validate_opening_stock / import._validate_opening_ar run under the lock and
--     see a batch committed meanwhile. Kinds do not block each other.
--   * finance.customer_ledger allows one opening_balance entry per customer (partial unique index),
--     the database-level backstop for opening AR whatever the isolation level. A hit inside
--     import._commit_opening_ar reads as ALREADY_IMPORTED (the batch is marked failed, row number kept).
--   Opening stock has no equivalent index (the receipt movements are ordinary ledger rows); it relies
--   on the lock plus the re-validation, which needs READ COMMITTED (the PostgREST default).
--
-- M-3 (orders half) · api.save_order_draft answered a replay before the customer and owner scope
--   checks, with the current lines, prices and totals. A rep who lost the customer (or a manager who
--   lost the order) could still read the draft by replaying an old call. The replay now re-runs the
--   same scope checks as a save (no state check, so a late replay after submit is still answered).
--   The answer shape is unchanged (the device keeps only order_id, version, status, created, replayed).
--
-- Functions are restated from their latest definitions (20261103000110_import_commands.sql,
-- 20261103000300_orders_offline_drafts.sql); only the blocks marked "Audit 4" change.
-- Tests: supabase/tests/database/47_audit4_imports_drafts.test.sql (M-6: suite 17).

-- ---------------------------------------------------------------------------
-- 1. One opening balance per customer (M-2). Fails loudly if duplicates already exist; they would
--    need a reversal decided by finance first (no data is changed here).
-- ---------------------------------------------------------------------------
create unique index if not exists customer_ledger_one_opening_balance_uidx
  on finance.customer_ledger (customer_id) where entry_type = 'opening_balance';
comment on index finance.customer_ledger_one_opening_balance_uidx is
  'Audit 4 M-2: a customer has at most one opening_balance ledger entry (opening AR imports).';

-- ---------------------------------------------------------------------------
-- 2. Opening AR posting: a unique-index hit reads as ALREADY_IMPORTED (M-2).
-- ---------------------------------------------------------------------------
create or replace function import._commit_opening_ar(p_batch uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare r record; v_entry bigint; v_count int := 0; v_total numeric := 0; v_state text; v_msg text;
begin
  for r in select id, row_no, normalized from import.rows where batch_id = p_batch order by row_no loop
    begin
      if exists (select 1 from finance.customer_ledger l
                 where l.customer_id = (r.normalized ->> 'customer_id')::uuid and l.entry_type = 'opening_balance') then
        raise exception 'ALREADY_IMPORTED: the customer already has an opening balance' using errcode = 'P0001';
      end if;
      insert into finance.customer_ledger (customer_id, entry_type, amount, source_table, source_id, posted_by)
      values ((r.normalized ->> 'customer_id')::uuid, 'opening_balance', (r.normalized ->> 'amount')::numeric,
              'import.rows', r.id, auth.uid())
      returning id into v_entry;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      if v_state = '23505' then
        -- Audit 4 M-2: customer_ledger_one_opening_balance_uidx (a concurrent or earlier opening balance).
        v_state := 'P0001'; v_msg := 'ALREADY_IMPORTED: the customer already has an opening balance';
      end if;
      raise exception using message = v_msg, errcode = v_state, detail = 'import_row=' || r.row_no;
    end;
    update import.rows set result = jsonb_build_object('ledger_entry_id', v_entry) where id = r.id;
    v_count := v_count + 1;
    v_total := v_total + (r.normalized ->> 'amount')::numeric;
  end loop;
  return jsonb_build_object('entries', v_count, 'total_amount', v_total);
end $$;

revoke all on function import._commit_opening_ar(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. api.import_commit: per-kind advisory lock before the re-validation (M-2).
-- ---------------------------------------------------------------------------
create or replace function api.import_commit(p_batch_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  b import.batches%rowtype; v_check jsonb; v_result jsonb; v_state text; v_msg text; v_detail text; v_row int;
begin
  perform authz.require('admin.import.run');
  select * into b from import.batches where id = p_batch_id for update;
  if not found then raise exception 'NOT_FOUND: import batch' using errcode = 'P0002'; end if;
  perform import._require(b.kind);
  if b.status = 'committed' then
    raise exception 'ALREADY_COMMITTED: the batch was committed on %', b.committed_at using errcode = 'P0001';
  end if;
  if b.status <> 'validated' then
    raise exception 'INVALID_STATE: only a validated batch can be committed (status %)', b.status using errcode = 'P0001';
  end if;

  -- Audit 4 M-2: one commit per import kind at a time. A second session committing another batch
  -- of the same kind waits here until the first one ends; its re-validation below then runs on a
  -- fresh snapshot (READ COMMITTED: each statement sees what committed before it started) and
  -- sees the first batch's opening stock or opening balances as "already imported".
  perform pg_advisory_xact_lock(hashtextextended('import.commit:' || b.kind, 0));

  -- Master data may have changed since validation (another batch, a manual edit).
  v_check := import._validate(p_batch_id);
  if (v_check ->> 'error_count')::int > 0 then
    return v_check || jsonb_build_object('committed', false);
  end if;

  begin
    v_result := case b.kind
      when 'customers' then import._commit_customers(p_batch_id)
      when 'products' then import._commit_products(p_batch_id)
      when 'customer_prices' then import._commit_customer_prices(p_batch_id)
      when 'opening_stock' then import._commit_opening_stock(p_batch_id)
      when 'opening_ar' then import._commit_opening_ar(p_batch_id)
    end;
  exception when others then
    -- Everything posted above is rolled back; only the failure record below survives.
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_detail = pg_exception_detail;
    v_row := (substring(v_detail from '^import_row=([0-9]+)$'))::int;
    update import.batches set status = 'failed', failure = left(v_msg, 500), failure_row_no = v_row
    where id = p_batch_id;
    return jsonb_build_object('batch_id', p_batch_id, 'kind', b.kind, 'status', 'failed', 'committed', false,
                              'failure', left(v_msg, 500), 'failure_sqlstate', v_state, 'failure_row_no', v_row);
  end;

  update import.rows set status = 'committed' where batch_id = p_batch_id;
  update import.batches set status = 'committed', committed_count = row_count, committed_at = now(),
         committed_by = auth.uid(), result = v_result, failure = null, failure_row_no = null
  where id = p_batch_id;

  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('import.committed', 'import.batch', p_batch_id,
          jsonb_build_object('batch_id', p_batch_id, 'kind', b.kind, 'rows', b.row_count, 'result', v_result));

  return jsonb_build_object('batch_id', p_batch_id, 'kind', b.kind, 'status', 'committed', 'committed', true,
                            'row_count', b.row_count, 'result', v_result);
end $$;

revoke execute on function api.import_commit(uuid) from public, anon;
grant execute on function api.import_commit(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. api.save_order_draft: scope checks before a replay is answered (M-3).
-- ---------------------------------------------------------------------------
create or replace function api.save_order_draft(p_order_id uuid, p_customer_id uuid, p_lines jsonb,
                                                p_notes text default null, p_visit_id uuid default null,
                                                p_version int default null, p_employee_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_me uuid := authz.current_employee_id(); v_emp uuid;
  v_order sales.orders%rowtype; v_cust crm.customers%rowtype; v_is_new boolean;
  v_rec record; v_variant uuid; v_qty numeric; v_disc numeric; v_tot record; v_version int;
  v_fp text; v_base int;
begin
  perform authz.require('sales.order.create');
  if p_order_id is null then raise exception 'VALIDATION: order id is required' using errcode = 'P0001'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'VALIDATION: lines must be a JSON array' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'VALIDATION: at most 200 lines per order' using errcode = 'P0001';
  end if;

  -- Offline drafts: lock the order first, then answer a replay of a save this caller already applied.
  -- Idempotency key = (order id, base version); the fingerprint makes sure it is the same request.
  v_emp := coalesce(p_employee_id, v_me);
  v_fp := md5(jsonb_build_object('customer_id', p_customer_id, 'lines', p_lines, 'notes', p_notes,
                                 'visit_id', p_visit_id, 'employee_id', v_emp)::text);
  select * into v_order from sales.orders where id = p_order_id for update;
  v_is_new := not found;
  if not v_is_new and exists (
       select 1 from sales.order_draft_saves s
       where s.order_id = p_order_id and s.base_version = coalesce(p_version, 0)
         and s.saved_by = v_uid and s.fingerprint = v_fp) then
    -- Audit 4 M-3: the answer carries the CURRENT draft (lines, prices, totals), so the caller must
    -- still be allowed to see it: the same customer and owner scope checks as a save, on the
    -- request's customer and on the order's current one. No state check: a late replay after
    -- submit is still answered.
    if exists (select 1 from crm.customers c
               where c.id in (p_customer_id, v_order.customer_id)
                 and not (authz.has_global('crm.customer.read')
                          or c.territory_id = any(authz.territory_ids('crm.customer.read'))
                          or c.id = any(authz.assigned_customer_ids('crm.customer.read')))) then
      raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
    end if;
    if not (authz.has_global('sales.order.create')
            or v_order.employee_id = any(authz.employee_ids('sales.order.create'))
            or v_order.created_by = v_uid) then
      raise exception 'PERMISSION_DENIED: order belongs to another representative' using errcode = '42501';
    end if;
    return sales.order_draft_answer(p_order_id, false, true);
  end if;

  -- Customer in the caller's CRM scope (same rule as api.visit_check_in).
  select * into v_cust from crm.customers where id = p_customer_id;
  if not found then raise exception 'NOT_FOUND: customer' using errcode = 'P0002'; end if;
  if not (authz.has_global('crm.customer.read')
          or v_cust.territory_id = any(authz.territory_ids('crm.customer.read'))
          or p_customer_id = any(authz.assigned_customer_ids('crm.customer.read'))) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  if v_cust.archived_at is not null or v_cust.lifecycle_stage = 'blocked' then
    raise exception 'CUSTOMER_BLOCKED: customer is archived or blocked' using errcode = 'P0001';
  end if;

  -- Whose order: the caller, or (managers) an employee within sales.order.create scope.
  if v_emp is null then raise exception 'NO_EMPLOYEE_PROFILE' using errcode = '42501'; end if;
  if v_emp is distinct from v_me and not (authz.has_global('sales.order.create')
                                          or v_emp = any(authz.employee_ids('sales.order.create'))) then
    raise exception 'PERMISSION_DENIED: employee is outside your scope' using errcode = '42501';
  end if;

  if p_visit_id is not null and not exists (
       select 1 from field.visits where id = p_visit_id and customer_id = p_customer_id) then
    raise exception 'VALIDATION: visit does not belong to this customer' using errcode = 'P0001';
  end if;

  if v_is_new then
    insert into sales.orders (id, customer_id, employee_id, visit_id, notes, payment_terms_days, created_by)
    values (p_order_id, p_customer_id, v_emp, p_visit_id, p_notes, v_cust.payment_terms_days, v_uid)
    returning * into v_order;
    insert into sales.order_status_history (order_id, from_status, to_status, changed_by, reason)
    values (p_order_id, null, 'draft', v_uid, 'draft created');
  else
    if not (authz.has_global('sales.order.create')
            or v_order.employee_id = any(authz.employee_ids('sales.order.create'))
            or v_order.created_by = v_uid) then
      raise exception 'PERMISSION_DENIED: order belongs to another representative' using errcode = '42501';
    end if;
    if v_order.status <> 'draft' then
      raise exception 'INVALID_STATE: order is %', v_order.status using errcode = 'P0001';
    end if;
    -- Optimistic concurrency. A NULL version is accepted only as a replay of the creating call.
    if p_version is null then
      if not (v_order.version = 1 and v_order.created_by = v_uid) then
        raise exception 'CONFLICT: order changed (current version %)', v_order.version using errcode = 'P0001';
      end if;
    elsif p_version <> v_order.version then
      raise exception 'CONFLICT: order changed (current version %)', v_order.version using errcode = 'P0001';
    end if;
    delete from sales.order_items where order_id = p_order_id;     -- draft lines only; no reservations exist
    update sales.orders set customer_id = p_customer_id, employee_id = v_emp, visit_id = p_visit_id,
           notes = p_notes, payment_terms_days = v_cust.payment_terms_days,
           version = case when p_version is null then version else version + 1 end, updated_at = now()
    where id = p_order_id;
  end if;

  for v_rec in select e.line, e.n from jsonb_array_elements(p_lines) with ordinality as e(line, n) loop
    if jsonb_typeof(v_rec.line) <> 'object' then
      raise exception 'VALIDATION: line % must be an object', v_rec.n using errcode = 'P0001';
    end if;
    if exists (select 1 from jsonb_object_keys(v_rec.line) k
               where k not in ('variant_id','quantity','requested_discount_pct')) then
      raise exception 'VALIDATION: line % may only contain variant_id, quantity, requested_discount_pct', v_rec.n
        using errcode = 'P0001';
    end if;
    v_variant := core.try_cast_uuid(v_rec.line ->> 'variant_id');
    if v_variant is null then raise exception 'VALIDATION: line % has no valid variant_id', v_rec.n using errcode = 'P0001'; end if;
    if jsonb_typeof(v_rec.line -> 'quantity') is distinct from 'number' then
      raise exception 'VALIDATION: line % quantity must be a number', v_rec.n using errcode = 'P0001';
    end if;
    v_qty := (v_rec.line ->> 'quantity')::numeric;
    if v_qty <> trunc(v_qty) or v_qty <= 0 or v_qty > 100000 then
      raise exception 'VALIDATION: line % quantity must be a whole number between 1 and 100000', v_rec.n using errcode = 'P0001';
    end if;
    if coalesce(jsonb_typeof(v_rec.line -> 'requested_discount_pct'), 'null') = 'null' then
      v_disc := 0;
    elsif jsonb_typeof(v_rec.line -> 'requested_discount_pct') <> 'number' then
      raise exception 'VALIDATION: line % discount must be a number', v_rec.n using errcode = 'P0001';
    else
      v_disc := (v_rec.line ->> 'requested_discount_pct')::numeric;
    end if;
    if v_disc < 0 or v_disc > 100 then
      raise exception 'VALIDATION: line % discount must be between 0 and 100', v_rec.n using errcode = 'P0001';
    end if;
    if not exists (select 1 from catalog.product_variants pv join catalog.products p on p.id = pv.product_id
                   where pv.id = v_variant and pv.status = 'active' and p.status = 'active') then
      raise exception 'NOT_FOUND: variant % is not sellable', v_variant using errcode = 'P0002';
    end if;
    insert into sales.order_items (order_id, line_no, variant_id, quantity, list_price, requested_discount_pct,
                                   tax_rate_pct, line_subtotal, line_discount, line_tax, line_total)
    values (p_order_id, v_rec.n, v_variant, v_qty::int, 0, round(v_disc, 2), 0, 0, 0, 0, 0);
  end loop;

  select * into v_tot from sales.price_order(p_order_id);
  update sales.orders set subtotal = v_tot.o_subtotal, discount_total = v_tot.o_discount, tax_total = v_tot.o_tax,
         total = v_tot.o_subtotal - v_tot.o_discount + v_tot.o_tax
  where id = p_order_id returning version into v_version;

  -- Offline drafts: remember the applied save under its key. A NULL-version re-save of a new draft
  -- (still version 1) replaces the record of the creating call.
  v_base := case when v_is_new then 0 else coalesce(p_version, 0) end;
  insert into sales.order_draft_saves (order_id, base_version, saved_by, fingerprint, result_version)
  values (p_order_id, v_base, v_uid, v_fp, v_version)
  on conflict (order_id, base_version) do update
    set saved_by = excluded.saved_by, fingerprint = excluded.fingerprint,
        result_version = excluded.result_version, saved_at = now();

  return sales.order_draft_answer(p_order_id, v_is_new, false);
end $$;

revoke execute on function api.save_order_draft(uuid, uuid, jsonb, text, uuid, int, uuid) from public, anon;
grant execute on function api.save_order_draft(uuid, uuid, jsonb, text, uuid, int, uuid) to authenticated;
