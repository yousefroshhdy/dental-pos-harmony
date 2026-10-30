-- Honest OS migration: third-audit fixes for receivables (AR) and dashboards. Tests: suite 31.
--
--   M1  AR mutations of one customer serialize on a per-customer transaction advisory lock
--       (finance.lock_customer_ar), taken before any row lock by allocate_payment,
--       reverse_allocation, reverse_payment, issue_credit_note and the credit-note decision hook.
--       FIFO allocation selects its candidate invoices FOR UPDATE in the same statement and
--       recomputes each open amount after the lock (no second, unlocked candidate query).
--   M2  record_payment bounds how far received_at may be back-dated: settings
--       finance.payment.max_backdate_days_rep (3) for callers without finance.payment.confirm on
--       the customer, finance.payment.max_backdate_days_finance (31) for finance. A received_at in
--       a closed KPI period (perf.period_close_at) is refused too. CASH_COLLECTED counts a payment
--       confirmed after its received period closed in the period of the confirmation (L3 below).
--   M6  update_collection_task: 'collected' only when nothing is open; 'close' and 'reopen' only for
--       finance.collection.manage in scope; the assignee may only 'promise' or 'escalate'. The
--       overdue scan reopens a task that was closed or marked collected while its invoice is still
--       open and past due (idempotent).
--   L1  kpi_summary returns a territory target only to company-wide KPI readers, target managers of
--       that territory, or readers whose KPI territory scope contains it; otherwise NULL.
--   L3  CASH_COLLECTED does not restate closed periods: a reversed/bounced payment still counts in
--       the period it was collected, and its reversal counts negative in the period of the reversal
--       (same rule as booked orders, DASHBOARDS.md §1). A reversal before the collection period
--       closed removes the payment from that period instead.
--
-- Non-destructive: create or replace of functions (signatures unchanged), new settings, new
-- internal helpers, updated KPI definition text. Every replaced function starts from its latest
-- definition in 20261031000100_finance_ar_commands.sql / 20261031000200_dashboards_kpis.sql.

-- ---------------------------------------------------------------------------
-- 0. Settings (owner-changeable; no secrets)
-- ---------------------------------------------------------------------------
insert into core.system_settings (key, value, description) values
  ('finance.payment.max_backdate_days_rep', '3',
   'Payments: how many Cairo days back received_at may be when the recorder cannot confirm payments (reps)'),
  ('finance.payment.max_backdate_days_finance', '31',
   'Payments: how many Cairo days back received_at may be when finance records it (never into a closed KPI period)')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Per-customer AR lock (M1). Internal; never client-callable.
-- ---------------------------------------------------------------------------
-- The advisory-lock key of a customer's receivables (one bigint, stable across sessions).
create or replace function finance.ar_lock_key(p_customer_id uuid) returns bigint
language sql immutable set search_path = '' as $$
  select hashtextextended('finance.ar:' || p_customer_id::text, 0)
$$;

-- Serialize every AR mutation of one customer until the end of the transaction. Taken before
-- any invoice or payment row lock, so the row-lock order inside cannot deadlock between them.
create or replace function finance.lock_customer_ar(p_customer_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_customer_id is not null then
    perform pg_advisory_xact_lock(finance.ar_lock_key(p_customer_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Credit notes: request and decision hook take the customer lock first (M1)
-- ---------------------------------------------------------------------------
create or replace function wf.on_decided_finance_credit_note(p_request_id uuid, p_approved boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r wf.approval_requests%rowtype; v_inv finance.invoices%rowtype; v_calc jsonb; v_id uuid; v_no text;
  v_today date := core.business_date();
begin
  select * into r from wf.approval_requests where id = p_request_id;
  if not p_approved then return; end if;
  v_id := r.entity_id;
  if exists (select 1 from finance.credit_notes where id = v_id) then return; end if;

  perform finance.lock_customer_ar((select i.customer_id from finance.invoices i
                                    where i.id = core.jsonb_uuid(r.payload, 'invoice_id')));
  select * into v_inv from finance.invoices where id = core.jsonb_uuid(r.payload, 'invoice_id') for update;
  if not found then raise exception 'NOT_FOUND: invoice of credit note request' using errcode = 'P0002'; end if;
  v_calc := finance.credit_note_amounts(v_inv.id,
              case when r.payload ->> 'mode' = 'lines'
                   then (select jsonb_agg(jsonb_build_object('invoice_item_id', l ->> 'invoice_item_id',
                                                             'quantity', (l ->> 'quantity')::int))
                         from jsonb_array_elements(r.payload -> 'lines') l) end,
              case when r.payload ->> 'mode' = 'amount' then (r.payload ->> 'amount')::numeric end);
  if (v_calc ->> 'total')::numeric <> (r.payload ->> 'total')::numeric then
    raise exception 'INVALID_STATE: the invoice changed since this credit note was requested; reject and request again'
      using errcode = 'P0001';
  end if;

  v_no := core.next_document_no('CN', v_today);
  insert into finance.credit_notes (id, credit_no, invoice_id, customer_id, reason, amount, tax_amount, issue_date,
                                    approval_request_id, created_by, idempotency_key)
  values (v_id, v_no, v_inv.id, v_inv.customer_id, r.payload ->> 'reason', (v_calc ->> 'amount')::numeric,
          (v_calc ->> 'tax_amount')::numeric, v_today, r.id, r.requested_by, r.payload ->> 'idempotency_key');
  if v_calc -> 'lines' is not null and jsonb_typeof(v_calc -> 'lines') = 'array' then
    insert into finance.credit_note_items (credit_note_id, invoice_item_id, quantity, amount, tax_amount)
    select v_id, (l ->> 'invoice_item_id')::uuid, (l ->> 'quantity')::int, (l ->> 'amount')::numeric,
           (l ->> 'tax_amount')::numeric
    from jsonb_array_elements(v_calc -> 'lines') l;
  end if;

  perform finance.post_ledger(v_inv.customer_id, 'credit_note', -(v_calc ->> 'total')::numeric, 'finance.credit_notes', v_id);
  perform finance.refresh_invoice_status(v_inv.id);
  perform crm._add_activity(v_inv.customer_id, authz.current_employee_id(), 'invoice',
                            'Credit note ' || v_no || ' on ' || v_inv.invoice_no, 'finance.credit_notes', v_id);
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('credit_note.issued', 'finance.credit_note', v_id,
          jsonb_build_object('credit_note_id', v_id, 'credit_no', v_no, 'invoice_id', v_inv.id,
                             'invoice_no', v_inv.invoice_no, 'customer_id', v_inv.customer_id,
                             'amount', (v_calc ->> 'amount')::numeric, 'tax_amount', (v_calc ->> 'tax_amount')::numeric,
                             'total', (v_calc ->> 'total')::numeric, 'issue_date', v_today, 'currency', v_inv.currency));
end $$;

create or replace function api.issue_credit_note(p_invoice_id uuid, p_lines jsonb default null, p_amount numeric default null,
                                                 p_reason text default null, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text := nullif(btrim(p_idempotency_key), '');
  v_reason text := nullif(btrim(p_reason), '');
  v_cn finance.credit_notes%rowtype; v_req wf.approval_requests%rowtype;
  v_inv finance.invoices%rowtype; v_calc jsonb; v_id uuid := gen_random_uuid(); v_request uuid;
  v_territory uuid; v_status text; v_customer uuid;
begin
  perform authz.require('finance.credit_note.issue');
  if v_key is null or length(v_key) > 100 then
    raise exception 'VALIDATION: idempotency key is required' using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'REASON_REQUIRED: a credit note needs a reason' using errcode = 'P0001';
  end if;

  select customer_id into v_customer from finance.invoices where id = p_invoice_id;
  if not found then raise exception 'NOT_FOUND: invoice %', p_invoice_id using errcode = 'P0002'; end if;
  if not authz.customer_in_scope('finance.credit_note.issue', v_customer) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  perform finance.lock_customer_ar(v_customer);
  select * into v_inv from finance.invoices where id = p_invoice_id for update;

  -- Replays: an issued note, or the request that is (or was) deciding it.
  select * into v_cn from finance.credit_notes where idempotency_key = v_key;
  if found then
    if v_cn.invoice_id <> p_invoice_id then
      raise exception 'IDEMPOTENCY_CONFLICT: key was used for another invoice' using errcode = 'P0001';
    end if;
    return jsonb_build_object('credit_note_id', v_cn.id, 'credit_no', v_cn.credit_no, 'status', 'issued',
                              'approval_request_id', v_cn.approval_request_id,
                              'total', v_cn.amount + v_cn.tax_amount, 'replayed', true);
  end if;
  select r.* into v_req from wf.approval_requests r join wf.workflow_definitions d on d.id = r.definition_id
  where d.code = 'finance.credit_note' and r.payload ->> 'idempotency_key' = v_key
  order by r.created_at desc limit 1;
  if found then
    if core.jsonb_uuid(v_req.payload, 'invoice_id') is distinct from p_invoice_id then
      raise exception 'IDEMPOTENCY_CONFLICT: key was used for another invoice' using errcode = 'P0001';
    end if;
    return jsonb_build_object('credit_note_id', v_req.entity_id, 'status',
                              case v_req.status when 'pending' then 'pending_approval' else v_req.status end,
                              'approval_request_id', v_req.id, 'total', (v_req.payload ->> 'total')::numeric,
                              'replayed', true);
  end if;

  if v_inv.status = 'written_off' then
    raise exception 'INVALID_STATE: invoice is %', v_inv.status using errcode = 'P0001';
  end if;
  v_calc := finance.credit_note_amounts(p_invoice_id, p_lines, p_amount);
  select territory_id into v_territory from crm.customers where id = v_inv.customer_id;

  v_request := wf.create_request('finance.credit_note', 'finance.credit_note', v_id,
    jsonb_build_object('credit_note_id', v_id, 'invoice_id', p_invoice_id, 'invoice_no', v_inv.invoice_no,
                       'customer_id', v_inv.customer_id, 'territory_id', v_territory,
                       'mode', case when p_amount is not null then 'amount' else 'lines' end,
                       'amount', (v_calc ->> 'amount')::numeric, 'tax_amount', (v_calc ->> 'tax_amount')::numeric,
                       'total', (v_calc ->> 'total')::numeric, 'lines', v_calc -> 'lines',
                       'reason', v_reason, 'idempotency_key', v_key,
                       'limit_metric', (v_calc ->> 'total')::numeric),
    null);
  v_status := case when exists (select 1 from finance.credit_notes where id = v_id) then 'issued' else 'pending_approval' end;
  return jsonb_build_object('credit_note_id', v_id, 'status', v_status, 'approval_request_id', v_request,
                            'credit_no', (select credit_no from finance.credit_notes where id = v_id),
                            'amount', (v_calc ->> 'amount')::numeric, 'tax_amount', (v_calc ->> 'tax_amount')::numeric,
                            'total', (v_calc ->> 'total')::numeric, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 3. Payments: back-date bounds (M2); reversal takes the customer lock (M1)
-- ---------------------------------------------------------------------------
create or replace function api.record_payment(p_customer_id uuid, p_amount numeric, p_method text,
                                              p_reference text default null, p_received_at timestamptz default null,
                                              p_client_ref uuid default null, p_cheque_due_date date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_emp uuid := authz.current_employee_id();
  v_existing finance.payments%rowtype;
  v_ref text := nullif(btrim(p_reference), '');
  v_at timestamptz := coalesce(p_received_at, now());
  v_id uuid := gen_random_uuid(); v_no text; v_confirm boolean;
  v_finance boolean; v_max_days int; v_day date;
begin
  perform authz.require('finance.payment.record');
  if p_client_ref is null then
    raise exception 'VALIDATION: client reference is required' using errcode = 'P0001';
  end if;

  select * into v_existing from finance.payments where client_ref = p_client_ref;
  if found then
    if v_existing.customer_id <> p_customer_id or v_existing.amount <> p_amount or v_existing.method <> p_method then
      raise exception 'IDEMPOTENCY_CONFLICT: client reference was used for another payment' using errcode = 'P0001';
    end if;
    return jsonb_build_object('payment_id', v_existing.id, 'payment_no', v_existing.payment_no,
                              'status', v_existing.status, 'replayed', true);
  end if;

  if not exists (select 1 from crm.customers where id = p_customer_id) then
    raise exception 'NOT_FOUND: customer' using errcode = 'P0002';
  end if;
  if not authz.customer_in_scope('finance.payment.record', p_customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) or p_amount > 100000000 then
    raise exception 'VALIDATION: amount must be positive with at most 2 decimals' using errcode = 'P0001';
  end if;
  -- Paymob methods arrive through the webhook integration (Phase 6), never by hand.
  if p_method is null or p_method not in ('cash','cheque','bank_transfer','instapay','other') then
    raise exception 'VALIDATION: unsupported payment method' using errcode = 'P0001';
  end if;
  if p_method = 'cheque' and (p_cheque_due_date is null or v_ref is null) then
    raise exception 'VALIDATION: a cheque needs its number and due date' using errcode = 'P0001';
  end if;
  if p_method <> 'cheque' and p_cheque_due_date is not null then
    raise exception 'VALIDATION: only cheques have a due date' using errcode = 'P0001';
  end if;
  if v_ref is not null and length(v_ref) > 100 then
    raise exception 'VALIDATION: reference is too long' using errcode = 'P0001';
  end if;
  if v_at > now() + interval '10 minutes' then
    raise exception 'VALIDATION: received_at is in the future' using errcode = 'P0001';
  end if;

  -- How far back received_at may go (Cairo days): the rep bound unless the caller can confirm
  -- payments of this customer. Never into a KPI period that has closed (CASH_COLLECTED).
  v_finance := authz.customer_in_scope('finance.payment.confirm', p_customer_id);
  v_max_days := greatest(coalesce(
    (select (s.value #>> '{}')::int from core.system_settings s
      where s.key = case when v_finance then 'finance.payment.max_backdate_days_finance'
                         else 'finance.payment.max_backdate_days_rep' end),
    case when v_finance then 31 else 3 end), 0);
  v_day := (v_at at time zone 'Africa/Cairo')::date;
  if v_day < core.business_date() - v_max_days then
    raise exception 'VALIDATION: received_at can be at most % days back', v_max_days using errcode = 'P0001';
  end if;
  if now() >= perf.period_close_at(v_day) then
    raise exception 'VALIDATION: received_at is in a closed period' using errcode = 'P0001';
  end if;

  -- Finance may confirm a non-cheque payment as it records it; a cheque waits until it clears.
  v_confirm := p_method <> 'cheque' and v_finance;

  v_no := core.next_document_no('PAY', core.business_date());
  insert into finance.payments (id, payment_no, client_ref, customer_id, collected_by, method, amount, received_at,
                                reference, cheque_due_date, status, confirmed_by, confirmed_at, created_by)
  values (v_id, v_no, p_client_ref, p_customer_id, v_emp, p_method, p_amount, v_at, v_ref, p_cheque_due_date,
          case when v_confirm then 'confirmed' else 'pending_verification' end,
          case when v_confirm then auth.uid() end, case when v_confirm then now() end, auth.uid());

  perform crm._add_activity(p_customer_id, v_emp, 'payment', 'Payment ' || v_no || ' recorded (' || p_method || ')',
                            'finance.payments', v_id);
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('payment.recorded', 'finance.payment', v_id,
          jsonb_build_object('payment_id', v_id, 'payment_no', v_no, 'customer_id', p_customer_id,
                             'method', p_method, 'amount', p_amount, 'currency', 'EGP', 'collected_by', v_emp,
                             'status', case when v_confirm then 'confirmed' else 'pending_verification' end));
  if v_confirm then
    perform finance.post_ledger(p_customer_id, 'payment', -p_amount, 'finance.payments', v_id);
    insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
    values ('payment.confirmed', 'finance.payment', v_id,
            jsonb_build_object('payment_id', v_id, 'payment_no', v_no, 'customer_id', p_customer_id,
                               'amount', p_amount, 'currency', 'EGP'));
  end if;

  return jsonb_build_object('payment_id', v_id, 'payment_no', v_no,
                            'status', case when v_confirm then 'confirmed' else 'pending_verification' end,
                            'replayed', false);
end $$;

create or replace function api.reverse_payment(p_payment_id uuid, p_reason text, p_bounced boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_p finance.payments%rowtype; v_reason text := nullif(btrim(p_reason), ''); v_status text;
  v_alloc record; v_invoices uuid[] := '{}'; v_inv uuid; v_count int := 0; v_customer uuid;
begin
  perform authz.require('finance.payment.reverse');
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'REASON_REQUIRED: say why the payment is reversed' using errcode = 'P0001';
  end if;
  select customer_id into v_customer from finance.payments where id = p_payment_id;
  if not found then raise exception 'NOT_FOUND: payment %', p_payment_id using errcode = 'P0002'; end if;
  if not authz.customer_in_scope('finance.payment.reverse', v_customer) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  perform finance.lock_customer_ar(v_customer);
  select * into v_p from finance.payments where id = p_payment_id for update;
  if v_p.status in ('bounced','reversed') and v_p.confirmed_at is not null then
    return jsonb_build_object('payment_id', v_p.id, 'status', v_p.status, 'replayed', true);
  end if;
  if v_p.status <> 'confirmed' then
    raise exception 'INVALID_STATE: payment is %', v_p.status using errcode = 'P0001';
  end if;
  v_status := case when coalesce(p_bounced, false) then 'bounced' else 'reversed' end;

  -- Lock the invoices this payment touched (id order, like allocate_payment) before un-allocating.
  perform 1 from finance.invoices i
  where i.id in (select pa.invoice_id from finance.payment_allocations pa where pa.payment_id = p_payment_id)
  order by i.id for update;
  for v_alloc in
    select pa.* from finance.payment_allocations pa
    where pa.payment_id = p_payment_id and pa.amount > 0
      and not exists (select 1 from finance.payment_allocations x where x.reverses_allocation_id = pa.id)
    order by pa.allocated_at, pa.id
  loop
    insert into finance.payment_allocations (payment_id, invoice_id, amount, reverses_allocation_id, allocated_by, reason)
    values (p_payment_id, v_alloc.invoice_id, -v_alloc.amount, v_alloc.id, auth.uid(), 'Payment reversed: ' || v_reason);
    v_count := v_count + 1;
    if not v_alloc.invoice_id = any(v_invoices) then v_invoices := v_invoices || v_alloc.invoice_id; end if;
  end loop;

  update finance.payments set status = v_status, status_reason = v_reason, reversed_at = now(), reversed_by = auth.uid()
  where id = p_payment_id;
  perform finance.post_ledger(v_p.customer_id, 'payment_reversal', v_p.amount, 'finance.payments', v_p.id);
  foreach v_inv in array v_invoices loop perform finance.refresh_invoice_status(v_inv); end loop;

  perform crm._add_activity(v_p.customer_id, authz.current_employee_id(), 'payment',
                            'Payment ' || v_p.payment_no || ' ' || v_status || ': ' || v_reason, 'finance.payments', v_p.id);
  perform crm._notify_employee(v_p.collected_by, 'payment.reversed', 'Payment ' || v_status || ': ' || v_p.payment_no,
                               v_reason, '/finance/payments/' || v_p.id, jsonb_build_object('payment_id', v_p.id));
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('payment.reversed', 'finance.payment', v_p.id,
          jsonb_build_object('payment_id', v_p.id, 'payment_no', v_p.payment_no, 'customer_id', v_p.customer_id,
                             'amount', v_p.amount, 'status', v_status, 'reason', v_reason,
                             'allocations_reversed', v_count));
  return jsonb_build_object('payment_id', v_p.id, 'status', v_status, 'allocations_reversed', v_count, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Allocation (M1). Order of locks: customer AR lock → payment row → invoice rows.
--    FIFO: one statement selects and locks the candidates; each open amount is read after
--    its row lock, so an allocation committed meanwhile is always seen.
-- ---------------------------------------------------------------------------
create or replace function api.allocate_payment(p_payment_id uuid, p_allocations jsonb default null,
                                                p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text := nullif(btrim(p_idempotency_key), '');
  v_p finance.payments%rowtype; v_left numeric; v_limit numeric; v_total numeric := 0;
  v_el jsonb; v_inv uuid; v_amt numeric; v_open numeric; v_status text; v_row record;
  v_req jsonb := '[]'::jsonb; v_ids uuid[] := '{}'; v_out jsonb := '[]'::jsonb; v_invoices jsonb := '[]'::jsonb;
  v_one jsonb; v_customer uuid;
begin
  perform authz.require('finance.payment.allocate');
  if v_key is not null and length(v_key) > 100 then
    raise exception 'VALIDATION: idempotency key is too long' using errcode = 'P0001';
  end if;

  select customer_id into v_customer from finance.payments where id = p_payment_id;
  if not found then raise exception 'NOT_FOUND: payment %', p_payment_id using errcode = 'P0002'; end if;
  if not authz.customer_in_scope('finance.payment.allocate', v_customer) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  perform finance.lock_customer_ar(v_customer);
  select * into v_p from finance.payments where id = p_payment_id for update;

  if v_key is not null and exists (select 1 from finance.payment_allocations where idempotency_key = v_key) then
    if exists (select 1 from finance.payment_allocations where idempotency_key = v_key and payment_id <> p_payment_id) then
      raise exception 'IDEMPOTENCY_CONFLICT: key was used for another payment' using errcode = 'P0001';
    end if;
    return jsonb_build_object('payment_id', p_payment_id, 'replayed', true,
      'allocations', (select jsonb_agg(jsonb_build_object('allocation_id', id, 'invoice_id', invoice_id, 'amount', amount) order by id)
                      from finance.payment_allocations where idempotency_key = v_key),
      'payment_unallocated', finance.payment_unallocated(p_payment_id));
  end if;

  if v_p.status <> 'confirmed' then
    raise exception 'INVALID_STATE: only confirmed payments can be allocated (payment is %)', v_p.status using errcode = 'P0001';
  end if;
  v_left := finance.payment_unallocated(p_payment_id);
  if v_left <= 0 then raise exception 'NOTHING_TO_ALLOCATE: the payment is fully allocated' using errcode = 'P0001'; end if;

  if p_allocations is null then
    -- FIFO, oldest due first, over exactly the invoices this statement locked.
    for v_row in
      select i.id from finance.invoices i
      where i.customer_id = v_p.customer_id and i.status in ('issued','partially_paid')
      order by i.due_date, i.issue_date, i.invoice_no, i.id
      for update
    loop
      exit when v_left - v_total <= 0;
      select b.o_open into v_open from finance.invoice_balance(v_row.id) b;   -- read after the lock
      continue when v_open is null or v_open <= 0;
      v_amt := least(v_open, v_left - v_total);
      v_req := v_req || jsonb_build_object('invoice_id', v_row.id, 'amount', v_amt);
      v_total := v_total + v_amt;
    end loop;
    if v_total = 0 then raise exception 'NOTHING_TO_ALLOCATE: the customer has no open invoices' using errcode = 'P0001'; end if;
  else
    if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 or jsonb_array_length(p_allocations) > 200 then
      raise exception 'VALIDATION: allocations must be a non-empty list' using errcode = 'P0001';
    end if;
    for v_el in select * from jsonb_array_elements(p_allocations) loop
      if jsonb_typeof(v_el) <> 'object'
         or exists (select 1 from jsonb_object_keys(v_el) k where k not in ('invoice_id','amount'))
         or core.try_cast_uuid(v_el ->> 'invoice_id') is null or jsonb_typeof(v_el -> 'amount') <> 'number' then
        raise exception 'VALIDATION: an allocation has only invoice_id and amount' using errcode = 'P0001';
      end if;
      v_inv := (v_el ->> 'invoice_id')::uuid; v_amt := (v_el ->> 'amount')::numeric;
      if v_amt <= 0 or v_amt <> round(v_amt, 2) then
        raise exception 'VALIDATION: allocation amounts are positive with at most 2 decimals' using errcode = 'P0001';
      end if;
      if v_inv = any(v_ids) then raise exception 'VALIDATION: an invoice appears twice' using errcode = 'P0001'; end if;
      v_ids := v_ids || v_inv;
      v_req := v_req || jsonb_build_object('invoice_id', v_inv, 'amount', v_amt);
      v_total := v_total + v_amt;
    end loop;
    perform 1 from finance.invoices where id = any(v_ids) order by id for update;
    for v_el in select * from jsonb_array_elements(v_req) loop
      v_inv := (v_el ->> 'invoice_id')::uuid; v_amt := (v_el ->> 'amount')::numeric;
      select status into v_status from finance.invoices where id = v_inv and customer_id = v_p.customer_id;
      if not found then raise exception 'VALIDATION: invoice % is not this customer''s', v_inv using errcode = 'P0001'; end if;
      if v_status not in ('issued','partially_paid') then
        raise exception 'INVOICE_CLOSED: invoice is %', v_status using errcode = 'P0001';
      end if;
      select o_open into v_open from finance.invoice_balance(v_inv);
      if v_amt > v_open then
        raise exception 'OVER_ALLOCATION: % exceeds the invoice''s open amount %', v_amt, v_open using errcode = 'P0001';
      end if;
    end loop;
    if v_total > v_left then
      raise exception 'OVER_ALLOCATION: % exceeds the payment''s unallocated %', v_total, v_left using errcode = 'P0001';
    end if;
  end if;

  v_limit := authz.max_limit('finance.payment.allocate');
  if v_limit is not null and v_total > v_limit then
    raise exception 'LIMIT_EXCEEDED: allocating % is above your limit %', v_total, v_limit using errcode = '42501';
  end if;

  for v_el in select * from jsonb_array_elements(v_req) loop
    insert into finance.payment_allocations (payment_id, invoice_id, amount, allocated_by, idempotency_key)
    values (p_payment_id, (v_el ->> 'invoice_id')::uuid, (v_el ->> 'amount')::numeric, auth.uid(), v_key)
    returning jsonb_build_object('allocation_id', id, 'invoice_id', invoice_id, 'amount', amount) into v_one;
    v_out := v_out || v_one;
    v_status := finance.refresh_invoice_status((v_el ->> 'invoice_id')::uuid);
    v_invoices := v_invoices || jsonb_build_object('id', (v_el ->> 'invoice_id')::uuid, 'status', v_status,
                    'open_amount', (select o_open from finance.invoice_balance((v_el ->> 'invoice_id')::uuid)));
  end loop;

  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('payment.allocated', 'finance.payment', p_payment_id,
          jsonb_build_object('payment_id', p_payment_id, 'payment_no', v_p.payment_no, 'customer_id', v_p.customer_id,
                             'allocated', v_total, 'allocations', v_out));
  return jsonb_build_object('payment_id', p_payment_id, 'allocations', v_out, 'allocated', v_total,
                            'payment_unallocated', finance.payment_unallocated(p_payment_id),
                            'invoices', v_invoices, 'fifo', p_allocations is null, 'replayed', false);
end $$;

create or replace function api.reverse_allocation(p_allocation_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_a finance.payment_allocations%rowtype; v_p finance.payments%rowtype; v_reason text := nullif(btrim(p_reason), '');
        v_id uuid; v_existing uuid; v_customer uuid;
begin
  perform authz.require('finance.payment.reverse');
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'REASON_REQUIRED: say why the allocation is reversed' using errcode = 'P0001';
  end if;
  select * into v_a from finance.payment_allocations where id = p_allocation_id;
  if not found then raise exception 'NOT_FOUND: allocation %', p_allocation_id using errcode = 'P0002'; end if;
  select customer_id into v_customer from finance.payments where id = v_a.payment_id;
  if not authz.customer_in_scope('finance.payment.reverse', v_customer) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  perform finance.lock_customer_ar(v_customer);
  select * into v_p from finance.payments where id = v_a.payment_id for update;
  if v_a.amount < 0 then raise exception 'INVALID_STATE: this row is itself a reversal' using errcode = 'P0001'; end if;
  perform 1 from finance.invoices where id = v_a.invoice_id for update;
  select id into v_existing from finance.payment_allocations where reverses_allocation_id = p_allocation_id;
  if v_existing is not null then
    return jsonb_build_object('reversal_id', v_existing, 'allocation_id', p_allocation_id, 'replayed', true);
  end if;

  insert into finance.payment_allocations (payment_id, invoice_id, amount, reverses_allocation_id, allocated_by, reason)
  values (v_a.payment_id, v_a.invoice_id, -v_a.amount, v_a.id, auth.uid(), v_reason)
  returning id into v_id;
  perform finance.refresh_invoice_status(v_a.invoice_id);
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('payment.allocation_reversed', 'finance.payment', v_a.payment_id,
          jsonb_build_object('payment_id', v_a.payment_id, 'allocation_id', v_a.id, 'reversal_id', v_id,
                             'invoice_id', v_a.invoice_id, 'amount', v_a.amount, 'reason', v_reason));
  return jsonb_build_object('reversal_id', v_id, 'allocation_id', p_allocation_id,
                            'invoice_status', (select status from finance.invoices where id = v_a.invoice_id),
                            'payment_unallocated', finance.payment_unallocated(v_a.payment_id), 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Collection tasks (M6)
--   finance.collection.manage in scope: promise, reopen, escalate, collected, close
--   the assignee (work.task.manage):     promise, escalate
--   'collected' only when nothing is open (invoice open amount, or customer balance for a task
--   without an invoice). A settled invoice completes its task automatically anyway.
-- ---------------------------------------------------------------------------
create or replace function api.update_collection_task(p_task_id uuid, p_action text, p_promised_date date default null,
                                                      p_promised_amount numeric default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_t finance.collection_tasks%rowtype; v_emp uuid := authz.current_employee_id();
  v_note text := nullif(btrim(p_note), ''); v_to text; v_manager boolean; v_assignee boolean; v_open numeric;
begin
  select * into v_t from finance.collection_tasks where id = p_task_id for update;
  if not found then raise exception 'NOT_FOUND: collection task %', p_task_id using errcode = 'P0002'; end if;
  v_manager := authz.has_permission('finance.collection.manage')
               and (authz.has_global('finance.collection.manage')
                    or v_t.assignee_employee_id = any(authz.employee_ids('finance.collection.manage'))
                    or authz.customer_in_scope('finance.collection.manage', v_t.customer_id));
  v_assignee := v_t.assignee_employee_id = v_emp and authz.has_permission('work.task.manage');
  if not (v_manager or v_assignee) then
    raise exception 'PERMISSION_DENIED: collection task is outside your scope' using errcode = '42501';
  end if;
  if v_note is not null and length(v_note) > 1000 then
    raise exception 'VALIDATION: note is too long' using errcode = 'P0001';
  end if;

  v_to := case p_action when 'promise' then 'promised' when 'reopen' then 'open' when 'escalate' then 'escalated'
                        when 'collected' then 'collected' when 'close' then 'closed' end;
  if v_to is null then raise exception 'VALIDATION: unknown action' using errcode = 'P0001'; end if;
  if not v_manager and p_action not in ('promise','escalate') then
    raise exception 'PERMISSION_DENIED: only finance can % a collection task', p_action using errcode = '42501';
  end if;
  if v_t.status in ('collected','closed') then
    raise exception 'INVALID_STATE: collection task is %', v_t.status using errcode = 'P0001';
  end if;
  if (p_action = 'reopen' and v_t.status not in ('promised','escalated'))
     or (p_action = 'escalate' and v_t.status = 'escalated') then
    raise exception 'INVALID_STATE: collection task is %', v_t.status using errcode = 'P0001';
  end if;
  if p_action = 'promise' then
    if p_promised_date is null or p_promised_date < core.business_date() or p_promised_date > core.business_date() + 365 then
      raise exception 'VALIDATION: promise date must be today or later' using errcode = 'P0001';
    end if;
    if p_promised_amount is not null and (p_promised_amount <= 0 or p_promised_amount <> round(p_promised_amount, 2)) then
      raise exception 'VALIDATION: promised amount must be positive' using errcode = 'P0001';
    end if;
  elsif p_action in ('close','escalate') and v_note is null then
    raise exception 'REASON_REQUIRED: add a note' using errcode = 'P0001';
  elsif p_action = 'collected' then
    if v_t.invoice_id is not null then
      select b.o_open into v_open from finance.invoice_balance(v_t.invoice_id) b;
    else
      select coalesce(sum(l.amount), 0) into v_open from finance.customer_ledger l where l.customer_id = v_t.customer_id;
    end if;
    if coalesce(v_open, 0) > 0 then
      raise exception 'INVOICE_STILL_OPEN: EGP % is still open; record and allocate the payment first', v_open
        using errcode = 'P0001';
    end if;
  end if;

  update finance.collection_tasks set
    status = v_to,
    promised_date = case when p_action = 'promise' then p_promised_date else promised_date end,
    promised_amount = case when p_action = 'promise' then p_promised_amount else promised_amount end,
    outcome = coalesce(v_note, outcome),
    closed_at = case when v_to in ('collected','closed') then now() end,
    updated_at = now(), updated_by = auth.uid()
  where id = p_task_id;
  if v_to in ('collected','closed') and v_t.work_task_id is not null then
    update work.tasks set status = 'done', completed_at = now(), outcome = coalesce(v_note, 'Collection ' || v_to)
    where id = v_t.work_task_id and status = 'open';
  end if;
  perform crm._add_activity(v_t.customer_id, v_emp, 'note',
    case p_action when 'promise' then 'Promise to pay by ' || p_promised_date
                                     || coalesce(' (EGP ' || p_promised_amount || ')', '')
                  else 'Collection ' || v_to end || coalesce(' — ' || v_note, ''),
    'finance.collection_tasks', p_task_id);
  return jsonb_build_object('task_id', p_task_id, 'status', v_to);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Overdue scan (M6): also reopens collection work that was closed or marked collected
-- while the invoice is still open and past due. Idempotent: a reopened task is 'open', so a
-- second run finds nothing to reopen; concurrent runs skip locked rows.
-- ---------------------------------------------------------------------------
create or replace function service.finance_overdue_scan(p_limit int default 500)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_today date := core.business_date(); r record; v_assignee uuid; v_task uuid; v_work uuid;
  v_created int := 0; v_unassigned int := 0; v_scanned int := 0; v_reopened int := 0;
  v_limit int := least(greatest(coalesce(p_limit, 500), 1), 5000);
begin
  for r in
    select i.id, i.invoice_no, i.customer_id, i.order_id, i.due_date, c.display_name
    from finance.invoices i join crm.customers c on c.id = i.customer_id
    where i.status in ('issued','partially_paid') and i.due_date < v_today
      and not exists (select 1 from finance.collection_tasks t where t.invoice_id = i.id)
    order by i.due_date, i.invoice_no
    limit v_limit
    for update of i skip locked
  loop
    v_scanned := v_scanned + 1;
    continue when (select o_open from finance.invoice_balance(r.id)) <= 0;
    select a.employee_id into v_assignee from crm.customer_assignments a
    where a.customer_id = r.customer_id and a.role = 'primary_rep' and a.valid_to is null limit 1;
    if v_assignee is null then
      select o.employee_id into v_assignee from sales.orders o where o.id = r.order_id;
    end if;
    if v_assignee is null then v_unassigned := v_unassigned + 1; continue; end if;

    insert into finance.collection_tasks (customer_id, invoice_id, assignee_employee_id, due_date, status)
    values (r.customer_id, r.id, v_assignee, v_today, 'open')
    on conflict (invoice_id) where invoice_id is not null do nothing
    returning id into v_task;
    continue when v_task is null;

    insert into work.tasks (title, kind, customer_id, assignee_employee_id, source, ref_table, ref_id, priority, due_at)
    values ('Collect overdue invoice ' || r.invoice_no, 'collection', r.customer_id, v_assignee, 'system',
            'finance.collection_tasks', v_task, 'high', (v_today::timestamp + time '17:00') at time zone 'Africa/Cairo')
    returning id into v_work;
    update finance.collection_tasks set work_task_id = v_work where id = v_task;

    perform notify.send_in_app((select e.user_id from core.employees e where e.id = v_assignee), 'invoice.overdue',
                               'Overdue invoice ' || r.invoice_no, r.display_name, '/finance/collections',
                               jsonb_build_object('invoice_id', r.id, 'collection_task_id', v_task));
    insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
    values ('invoice.overdue', 'finance.invoice', r.id,
            jsonb_build_object('invoice_id', r.id, 'invoice_no', r.invoice_no, 'customer_id', r.customer_id,
                               'due_date', r.due_date, 'days_overdue', v_today - r.due_date,
                               'open_amount', (select o_open from finance.invoice_balance(r.id)),
                               'collection_task_id', v_task, 'assignee_employee_id', v_assignee));
    v_created := v_created + 1;
  end loop;

  -- Collection work ended while the invoice is still owed and overdue goes back to the assignee.
  for r in
    select t.id as task_id, t.work_task_id, t.assignee_employee_id, i.id as invoice_id, i.invoice_no, c.display_name
    from finance.collection_tasks t
    join finance.invoices i on i.id = t.invoice_id
    join crm.customers c on c.id = t.customer_id
    where t.status in ('collected','closed') and i.status in ('issued','partially_paid') and i.due_date < v_today
    order by i.due_date, i.invoice_no
    limit v_limit
    for update of t skip locked
  loop
    continue when (select o_open from finance.invoice_balance(r.invoice_id)) <= 0;
    update finance.collection_tasks
       set status = 'open', closed_at = null, updated_at = now(), updated_by = auth.uid(),
           outcome = 'Reopened: invoice still open and overdue'
     where id = r.task_id;
    if r.work_task_id is not null then
      update work.tasks set status = 'open', completed_at = null, outcome = null
      where id = r.work_task_id and status = 'done';
    end if;
    perform notify.send_in_app((select e.user_id from core.employees e where e.id = r.assignee_employee_id),
                               'invoice.overdue', 'Overdue invoice ' || r.invoice_no || ' reopened', r.display_name,
                               '/finance/collections',
                               jsonb_build_object('invoice_id', r.invoice_id, 'collection_task_id', r.task_id, 'reopened', true));
    v_reopened := v_reopened + 1;
  end loop;

  return jsonb_build_object('business_date', v_today, 'scanned', v_scanned, 'created', v_created,
                            'unassigned', v_unassigned, 'reopened', v_reopened);
end $$;

-- ---------------------------------------------------------------------------
-- 7. CASH_COLLECTED without restating closed periods (L3, M2)
--   counted_at  = received_at, unless finance confirmed it after the received period closed
--                 (then the confirmation instant): a late confirmation lands in an open period.
--   +amount     in the period of counted_at, for confirmed payments and for reversed/bounced
--               ones whose reversal came after that period closed.
--   −amount     in the period of reversed_at, for those late reversals.
--   A reversal before the collection period closed just removes the payment from that period.
-- ---------------------------------------------------------------------------
create or replace function perf.metric_cash_collected(p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns perf.metric_result language sql stable set search_path = '' as $$
  with bounds as (select perf.cairo_start(p_from) as t0, perf.cairo_start(p_to + 1) as t1),
  pay as (
    select p.id, p.amount, p.status, p.reversed_at, x.counted_at,
           perf.period_close_at((x.counted_at at time zone 'Africa/Cairo')::date) as closes_at
    from finance.payments p
    join crm.customers c on c.id = p.customer_id
    cross join bounds b
    cross join lateral (
      select case when p.confirmed_at is null
                    or p.confirmed_at < perf.period_close_at((p.received_at at time zone 'Africa/Cairo')::date)
                  then p.received_at else p.confirmed_at end as counted_at) x
    where (p.status = 'confirmed' or (p.status in ('reversed','bounced') and p.confirmed_at is not null))
      and ((p.received_at >= b.t0 and p.received_at < b.t1)
           or (p.confirmed_at >= b.t0 and p.confirmed_at < b.t1)
           or (p.reversed_at >= b.t0 and p.reversed_at < b.t1))
      and (p_emp is null or p.collected_by = any(p_emp))
      and (p_terr is null or c.territory_id = any(p_terr))
  ),
  moves as (
    select p.id, p.amount as amt from pay p, bounds b
     where p.counted_at >= b.t0 and p.counted_at < b.t1
       and (p.status = 'confirmed' or p.reversed_at >= p.closes_at)
    union all
    select p.id, -p.amount from pay p, bounds b
     where p.status <> 'confirmed' and p.reversed_at >= p.closes_at
       and p.reversed_at >= b.t0 and p.reversed_at < b.t1
  )
  select row(coalesce(sum(m.amt), 0)::numeric(14,2),
             jsonb_build_object('payments', count(*) filter (where m.amt > 0),
                                'reversals', count(*) filter (where m.amt < 0),
                                'collected', coalesce(sum(m.amt) filter (where m.amt > 0), 0),
                                'reversed', coalesce(-sum(m.amt) filter (where m.amt < 0), 0)),
             coalesce(array_agg(m.id), '{}'))::perf.metric_result
  from moves m
$$;

update perf.kpi_definitions
   set definition = 'Confirmed payments collected in the period (cash, VAT included). A later bounce or reversal does not restate a closed period: it counts negative in the period it happens',
       formula = 'Σ payments.amount by received_at (by confirmed_at if confirmed after that period closed) − Σ amounts of payments reversed after their period closed, by reversed_at'
 where code = 'CASH_COLLECTED';

-- ---------------------------------------------------------------------------
-- 8. kpi_summary (L1): a territory target only for callers who may see that territory's targets
-- ---------------------------------------------------------------------------
create or replace function api.kpi_summary(p_from date, p_to date, p_employee_id uuid default null,
                                           p_territory_id uuid default null)
returns table (kpi_code text, unit text, higher_is_better boolean, is_point_in_time boolean,
               value numeric, target numeric, achievement_pct numeric, detail jsonb)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_emp uuid[]; v_terr uuid[]; v_stock boolean; v_target_ok boolean;
begin
  perform authz.require('perf.kpi.read');
  perform perf.check_period(p_from, p_to);
  v_emp  := perf.resolve_employee_filter(p_employee_id);
  v_terr := case when p_territory_id is not null then perf.territory_tree(p_territory_id) end;
  v_stock := v_emp is null and v_terr is null and authz.has_permission('inventory.stock.read');
  -- Employee targets are already scoped (resolve_employee_filter); a territory total's target is
  -- shown to company-wide KPI readers, target managers of that territory and readers whose KPI
  -- territory scope contains it (authz.territory_ids includes sub-territories).
  v_target_ok := p_employee_id is not null or p_territory_id is null
                 or authz.has_global('perf.kpi.read')
                 or authz.has_global('perf.target.manage')
                 or p_territory_id = any(authz.territory_ids('perf.target.manage'))
                 or p_territory_id = any(authz.territory_ids('perf.kpi.read'));
  return query
    select d.code, d.unit, d.higher_is_better, d.is_point_in_time, m.value, t.target,
           perf.achievement(m.value, t.target, d.higher_is_better), m.detail
    from perf.kpi_definitions d
    cross join lateral perf.compute_metric(d.metric_key, v_emp, v_terr, p_from, p_to) m
    cross join lateral (select case when v_target_ok
                                    then perf.target_for(d, p_employee_id, v_emp, p_territory_id, p_from, p_to) end as target) t
    where d.status = 'active' and (d.code <> 'STOCK_ALERTS' or v_stock)
    order by d.code;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Privileges. create or replace keeps existing ACLs; the new helpers are internal.
-- ---------------------------------------------------------------------------
revoke all on function
  finance.ar_lock_key(uuid),
  finance.lock_customer_ar(uuid),
  perf.metric_cash_collected(uuid[], uuid[], date, date)
from public, anon, authenticated;

revoke all on function service.finance_overdue_scan(int) from public, anon, authenticated;
grant execute on function service.finance_overdue_scan(int) to service_role;

revoke execute on function
  api.issue_credit_note(uuid, jsonb, numeric, text, text),
  api.record_payment(uuid, numeric, text, text, timestamptz, uuid, date),
  api.reverse_payment(uuid, text, boolean),
  api.allocate_payment(uuid, jsonb, text),
  api.reverse_allocation(uuid, text),
  api.update_collection_task(uuid, text, date, numeric, text),
  api.kpi_summary(date, date, uuid, uuid),
  wf.on_decided_finance_credit_note(uuid, boolean)
from public, anon;
revoke execute on function wf.on_decided_finance_credit_note(uuid, boolean) from authenticated;
grant execute on function
  api.issue_credit_note(uuid, jsonb, numeric, text, text),
  api.record_payment(uuid, numeric, text, text, timestamptz, uuid, date),
  api.reverse_payment(uuid, text, boolean),
  api.allocate_payment(uuid, jsonb, text),
  api.reverse_allocation(uuid, text),
  api.update_collection_task(uuid, text, date, numeric, text),
  api.kpi_summary(date, date, uuid, uuid)
to authenticated;
