-- Honest OS migration: invoice write-off (bad debt) and printable documents. Tests: suite 38.
--
-- Closes the 2026-11-01 audit's "known and accepted" item: the overdue scan kept reopening a
-- collection task finance had closed on purpose while the invoice stayed open. An invoice can
-- now be written off (fully or partly) through an approval:
--
--   api.request_invoice_write_off(invoice, amount, reason, key)
--       finance.collection.manage holders, customer in their scope; amount ≤ the open amount;
--       idempotent per key; one pending write-off per invoice. Always goes through the new
--       workflow 'finance.write_off' (one stage: wf.decide.write_off, limit = EGP). The requester
--       never decides their own request (api.decide_approval, SELF_APPROVAL).
--   wf.on_decided_finance_write_off (hook; dispatched from …0599_dispatch.sql)
--       re-checks the amount against the invoice as it is at decision time, writes the
--       finance.invoice_write_offs row (WO-YYYY-nnnnnn) and posts a 'write_off' ledger entry
--       (−amount; the entry type already exists in finance.customer_ledger). A write-off that
--       leaves nothing open marks the invoice 'written_off' and closes its collection work.
--
-- Why a written-off invoice stops reopening collection tasks: the overdue scan
-- (service.finance_overdue_scan, 20261101000100) only creates or reopens tasks for invoices in
-- status issued/partially_paid whose open amount is > 0. A fully written-off invoice is in status
-- 'written_off' and its open amount is 0, so both loops skip it; the scan itself is unchanged.
-- A partly written-off invoice keeps the unpaid rest open and is still collected.
--
-- Open amount everywhere = total − net allocations − credit notes (incl. VAT) − write-offs:
-- finance.invoice_balance (same signature; every command uses it), api.v_invoices (+ column
-- written_off), api.v_ar_aging, api.v_collection_tasks, perf.overdue_invoices.
-- finance.refresh_invoice_status: 'written_off' is final only while nothing is open — if a
-- payment allocated before the write-off later bounces, the invoice is owed again and goes
-- back to issued/partially_paid (and is collected again), instead of hiding the debt.
--
-- Printing: company header settings (synthetic placeholders; the owner edits them) and
-- api.company_profile(); api.v_invoice_print_party (customer block of the printed invoice).
--
-- Non-destructive: new table, permission, workflow, settings, functions and view; create or
-- replace of functions with unchanged signatures and of views with unchanged columns
-- (v_invoices gains one column at the end). Each replaced object starts from its latest
-- definition: invoice_balance / refresh_invoice_status (20261031000100), the views
-- (20261031000110), perf.overdue_invoices (20261031000200).

-- ---------------------------------------------------------------------------
-- 0. Reference data: permission, role grant, workflow, settings
-- ---------------------------------------------------------------------------
insert into authz.permissions (code, module, description, supports_limit, is_sensitive)
values ('wf.decide.write_off', 'wf', 'Decide invoice write-offs (limit = EGP)', true, true)
on conflict (code) do nothing;

-- Working default: finance officers decide write-offs (no EGP limit; an admin can set one).
-- The owner decides anything implicitly. Collection officers may request but not decide.
insert into authz.role_permissions (role_id, permission_code, scope, limit_value)
select r.id, 'wf.decide.write_off', 'all', null from authz.roles r where r.code = 'finance_officer'
on conflict (role_id, permission_code) do nothing;

with def as (
  insert into wf.workflow_definitions (code, name, entity_type)
  values ('finance.write_off', 'Invoice write-off', 'finance.invoice_write_off')
  on conflict (code) do nothing
  returning id
), rule as (
  insert into wf.workflow_rules (definition_id, priority, condition)
  select id, 100, '{}'::jsonb from def
  returning id
)
insert into wf.workflow_stages (rule_id, stage_no, approver_type, approver_permission)
select id, 1, 'permission', 'wf.decide.write_off' from rule;

-- Company header of printed invoices and receipts. Obviously synthetic placeholders (no real
-- data before the D-03 legal review); the owner replaces them in the settings.
insert into core.system_settings (key, value, description) values
  ('company.legal_name_ar', '"أونست للتجارة (اسم مؤقت)"', 'Printed documents: legal company name in Arabic'),
  ('company.legal_name_en', '"Honest Trading (placeholder name)"', 'Printed documents: legal company name in English'),
  ('company.address_ar', '"عنوان مؤقت — يُضبط من الإعدادات"', 'Printed documents: company address in Arabic'),
  ('company.address_en', '"Placeholder address — set in settings"', 'Printed documents: company address in English'),
  ('company.tax_registration_no', '"000-000-000"', 'Printed documents: tax registration number (placeholder)'),
  ('company.commercial_register_no', '"00000"', 'Printed documents: commercial register number (placeholder)'),
  ('company.phone', '"+200000000000"', 'Printed documents: company phone, E.164 (placeholder)'),
  ('company.logo_url', '""', 'Printed documents: https URL of the logo; empty = no logo')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 1. finance.invoice_write_offs (append-only; one row per approved write-off)
-- ---------------------------------------------------------------------------
create table if not exists finance.invoice_write_offs (
  id                  uuid primary key,                  -- = the approval request's entity_id
  write_off_no        text not null unique,
  invoice_id          uuid not null references finance.invoices(id),
  customer_id         uuid not null references crm.customers(id),
  amount              core.money not null check (amount > 0),   -- VAT-inclusive, like the open amount
  reason              text not null check (length(reason) between 3 and 500),
  approval_request_id uuid not null unique references wf.approval_requests(id),
  idempotency_key     text unique,
  requested_by        uuid references auth.users(id),
  posted_by           uuid references auth.users(id),
  posted_at           timestamptz not null default now()
);
create index if not exists idx_invoice_write_offs_invoice on finance.invoice_write_offs (invoice_id);
create index if not exists idx_invoice_write_offs_customer on finance.invoice_write_offs (customer_id);
create trigger trg_invoice_write_offs_append_only before update or delete on finance.invoice_write_offs
  for each row execute function core.forbid_mutation();
create trigger trg_audit after insert on finance.invoice_write_offs
  for each row execute function audit.log_change();
alter table finance.invoice_write_offs enable row level security;
grant select on finance.invoice_write_offs to authenticated;
-- Visible with its invoice (finance.invoice.read and the customer in scope).
create policy invoice_write_offs_select on finance.invoice_write_offs for select to authenticated using (
  exists (select 1 from finance.invoices i where i.id = invoice_write_offs.invoice_id));

-- ---------------------------------------------------------------------------
-- 2. Balance helpers (internal definers; never client-callable — revoked in §8)
-- ---------------------------------------------------------------------------
create or replace function finance.invoice_written_off(p_invoice_id uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(w.amount), 0)::numeric(14,2) from finance.invoice_write_offs w where w.invoice_id = p_invoice_id
$$;

-- What is still owed on one invoice. open = total − net allocations − credit notes (incl. VAT)
-- − write-offs. Starts from 20261031000100 §1 (signature unchanged).
create or replace function finance.invoice_balance(p_invoice_id uuid,
  out o_total numeric, out o_allocated numeric, out o_credited numeric, out o_open numeric)
language sql stable security definer set search_path = '' as $$
  select i.total,
         a.s, c.s, (i.total - a.s - c.s - w.s)
  from finance.invoices i
  cross join lateral (select coalesce(sum(pa.amount), 0)::numeric(14,2) as s
                      from finance.payment_allocations pa where pa.invoice_id = i.id) a
  cross join lateral (select coalesce(sum(cn.amount + cn.tax_amount), 0)::numeric(14,2) as s
                      from finance.credit_notes cn where cn.invoice_id = i.id) c
  cross join lateral (select coalesce(sum(wo.amount), 0)::numeric(14,2) as s
                      from finance.invoice_write_offs wo where wo.invoice_id = i.id) w
  where i.id = p_invoice_id
$$;

-- Invoice status from its balance. Starts from 20261031000100 §1; 'written_off' is now final
-- only while nothing is open (a later payment bounce makes the invoice owed again).
create or replace function finance.refresh_invoice_status(p_invoice_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_inv finance.invoices%rowtype; b record; v_status text;
begin
  select * into v_inv from finance.invoices where id = p_invoice_id;
  if not found then return null; end if;
  select * into b from finance.invoice_balance(p_invoice_id);
  if v_inv.status = 'written_off' and b.o_open <= 0 then return v_inv.status; end if;
  v_status := case when b.o_open <= 0 and v_inv.total > 0 and b.o_credited >= v_inv.total then 'credited'
                   when b.o_open <= 0 then 'paid'
                   when b.o_allocated > 0 then 'partially_paid'
                   else 'issued' end;
  if v_status is distinct from v_inv.status then
    update finance.invoices set status = v_status where id = p_invoice_id;
  end if;
  perform finance.sync_collection_tasks(p_invoice_id, b.o_open, v_inv.due_date);
  return v_status;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Decision hook: post the write-off once approved
-- ---------------------------------------------------------------------------
create or replace function wf.on_decided_finance_write_off(p_request_id uuid, p_approved boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r wf.approval_requests%rowtype; v_inv finance.invoices%rowtype; v_id uuid; v_no text;
  v_amount numeric; v_open numeric; v_left numeric; v_today date := core.business_date();
begin
  select * into r from wf.approval_requests where id = p_request_id;
  if not p_approved then return; end if;
  v_id := r.entity_id;
  if exists (select 1 from finance.invoice_write_offs where id = v_id) then return; end if;

  perform finance.lock_customer_ar((select i.customer_id from finance.invoices i
                                    where i.id = core.jsonb_uuid(r.payload, 'invoice_id')));
  select * into v_inv from finance.invoices where id = core.jsonb_uuid(r.payload, 'invoice_id') for update;
  if not found then raise exception 'NOT_FOUND: invoice of write-off request' using errcode = 'P0002'; end if;

  v_amount := (r.payload ->> 'amount')::numeric;
  select b.o_open into v_open from finance.invoice_balance(v_inv.id) b;
  if v_amount is null or v_amount <= 0 or v_amount > v_open then
    raise exception 'EXCEEDS_INVOICE_OPEN_AMOUNT: the write-off % is above the open amount % now; reject and request again',
      v_amount, v_open using errcode = 'P0001';
  end if;

  v_no := core.next_document_no('WO', v_today);
  insert into finance.invoice_write_offs (id, write_off_no, invoice_id, customer_id, amount, reason,
                                          approval_request_id, idempotency_key, requested_by, posted_by)
  values (v_id, v_no, v_inv.id, v_inv.customer_id, v_amount, r.payload ->> 'reason', r.id,
          r.payload ->> 'idempotency_key', r.requested_by, auth.uid());
  perform finance.post_ledger(v_inv.customer_id, 'write_off', -v_amount, 'finance.invoice_write_offs', v_id);

  v_left := v_open - v_amount;
  if v_left <= 0 then
    update finance.invoices set status = 'written_off' where id = v_inv.id;
    -- Collection work ends as 'closed' (not 'collected'): nothing was collected.
    update work.tasks w set status = 'done', completed_at = now(), outcome = coalesce(w.outcome, 'Written off: ' || v_no)
    from finance.collection_tasks t
    where t.invoice_id = v_inv.id and t.status in ('open','promised','escalated')
      and w.id = t.work_task_id and w.status = 'open';
    update finance.collection_tasks
       set status = 'closed', closed_at = now(), updated_at = now(), updated_by = auth.uid(),
           outcome = 'Written off: ' || v_no
     where invoice_id = v_inv.id and status in ('open','promised','escalated');
  else
    perform finance.refresh_invoice_status(v_inv.id);
  end if;

  perform crm._add_activity(v_inv.customer_id, authz.current_employee_id(), 'invoice',
                            'Write-off ' || v_no || ' on ' || v_inv.invoice_no, 'finance.invoice_write_offs', v_id);
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('invoice.written_off', 'finance.invoice', v_inv.id,
          jsonb_build_object('write_off_id', v_id, 'write_off_no', v_no, 'invoice_id', v_inv.id,
                             'invoice_no', v_inv.invoice_no, 'customer_id', v_inv.customer_id,
                             'amount', v_amount, 'open_after', greatest(v_left, 0), 'fully_written_off', v_left <= 0,
                             'currency', v_inv.currency, 'approval_request_id', r.id));
end $$;

-- ---------------------------------------------------------------------------
-- 4. api.request_invoice_write_off
-- ---------------------------------------------------------------------------
create or replace function api.request_invoice_write_off(p_invoice_id uuid, p_amount numeric, p_reason text,
                                                         p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text := nullif(btrim(p_idempotency_key), '');
  v_reason text := nullif(btrim(p_reason), '');
  v_customer uuid; v_inv finance.invoices%rowtype; v_wo finance.invoice_write_offs%rowtype;
  v_req wf.approval_requests%rowtype; v_open numeric; v_territory uuid;
  v_id uuid := gen_random_uuid(); v_request uuid; v_status text;
begin
  perform authz.require('finance.collection.manage');
  if v_key is null or length(v_key) > 100 then
    raise exception 'VALIDATION: idempotency key is required' using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'REASON_REQUIRED: a write-off needs a reason' using errcode = 'P0001';
  end if;
  if length(v_reason) > 500 then
    raise exception 'VALIDATION: reason is too long' using errcode = 'P0001';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) or p_amount > 100000000 then
    raise exception 'VALIDATION: amount must be positive with at most 2 decimals' using errcode = 'P0001';
  end if;

  select customer_id into v_customer from finance.invoices where id = p_invoice_id;
  if not found then raise exception 'NOT_FOUND: invoice %', p_invoice_id using errcode = 'P0002'; end if;
  if not authz.customer_in_scope('finance.collection.manage', v_customer) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  perform finance.lock_customer_ar(v_customer);
  select * into v_inv from finance.invoices where id = p_invoice_id for update;

  -- Replays: a posted write-off, or the request that is (or was) deciding it.
  select * into v_wo from finance.invoice_write_offs where idempotency_key = v_key;
  if found then
    if v_wo.invoice_id <> p_invoice_id or v_wo.amount <> p_amount then
      raise exception 'IDEMPOTENCY_CONFLICT: key was used for another write-off' using errcode = 'P0001';
    end if;
    return jsonb_build_object('write_off_id', v_wo.id, 'write_off_no', v_wo.write_off_no, 'status', 'posted',
                              'approval_request_id', v_wo.approval_request_id, 'amount', v_wo.amount,
                              'invoice_status', v_inv.status, 'replayed', true);
  end if;
  select r.* into v_req from wf.approval_requests r join wf.workflow_definitions d on d.id = r.definition_id
  where d.code = 'finance.write_off' and r.payload ->> 'idempotency_key' = v_key
  order by r.created_at desc limit 1;
  if found then
    if core.jsonb_uuid(v_req.payload, 'invoice_id') is distinct from p_invoice_id
       or (v_req.payload ->> 'amount')::numeric is distinct from p_amount then
      raise exception 'IDEMPOTENCY_CONFLICT: key was used for another write-off' using errcode = 'P0001';
    end if;
    return jsonb_build_object('write_off_id', v_req.entity_id, 'status',
                              case v_req.status when 'pending' then 'pending_approval' else v_req.status end,
                              'approval_request_id', v_req.id, 'amount', (v_req.payload ->> 'amount')::numeric,
                              'invoice_status', v_inv.status, 'replayed', true);
  end if;

  if exists (select 1 from wf.approval_requests r join wf.workflow_definitions d on d.id = r.definition_id
             where d.code = 'finance.write_off' and r.status = 'pending'
               and core.jsonb_uuid(r.payload, 'invoice_id') = p_invoice_id) then
    raise exception 'WRITE_OFF_PENDING: a write-off of this invoice is already waiting for a decision' using errcode = 'P0001';
  end if;
  select b.o_open into v_open from finance.invoice_balance(p_invoice_id) b;
  if v_inv.status not in ('issued','partially_paid') or v_open <= 0 then
    raise exception 'INVALID_STATE: invoice is % with nothing open', v_inv.status using errcode = 'P0001';
  end if;
  if p_amount > v_open then
    raise exception 'EXCEEDS_INVOICE_OPEN_AMOUNT: write-off % exceeds the open amount %', p_amount, v_open
      using errcode = 'P0001';
  end if;
  select territory_id into v_territory from crm.customers where id = v_inv.customer_id;

  v_request := wf.create_request('finance.write_off', 'finance.invoice_write_off', v_id,
    jsonb_build_object('write_off_id', v_id, 'invoice_id', p_invoice_id, 'invoice_no', v_inv.invoice_no,
                       'customer_id', v_inv.customer_id, 'territory_id', v_territory,
                       'amount', p_amount, 'open_amount', v_open, 'full', p_amount = v_open,
                       'reason', v_reason, 'idempotency_key', v_key, 'limit_metric', p_amount),
    null);
  v_status := case when exists (select 1 from finance.invoice_write_offs where id = v_id) then 'posted' else 'pending_approval' end;
  return jsonb_build_object('write_off_id', v_id, 'status', v_status, 'approval_request_id', v_request,
                            'write_off_no', (select write_off_no from finance.invoice_write_offs where id = v_id),
                            'amount', p_amount, 'open_amount', v_open,
                            'invoice_status', (select status from finance.invoices where id = p_invoice_id),
                            'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Company header for printed documents
-- ---------------------------------------------------------------------------
-- The non-secret company.* settings, for any active user who can read invoices or payments.
create or replace function api.company_profile() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.is_active_user()
     or not (authz.has_permission('finance.invoice.read') or authz.has_permission('finance.payment.read')) then
    raise exception 'PERMISSION_DENIED: reading the company profile needs finance.invoice.read or finance.payment.read'
      using errcode = '42501';
  end if;
  return coalesce((select jsonb_object_agg(substr(s.key, 9), s.value)
                   from core.system_settings s
                   where s.key in ('company.name','company.legal_name_ar','company.legal_name_en','company.address_ar',
                                   'company.address_en','company.tax_registration_no','company.commercial_register_no',
                                   'company.phone','company.logo_url','company.currency')
                     and not s.is_secret), '{}'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Views (security_invoker). Open amount now also subtracts write-offs.
-- ---------------------------------------------------------------------------
create or replace view api.v_invoices with (security_invoker = true) as
  select i.id, i.invoice_no, i.order_id, o.order_no, i.customer_id, c.customer_no, c.display_name as customer_name,
         c.territory_id, o.employee_id as rep_employee_id, rep.full_name_en as rep_name_en, rep.full_name_ar as rep_name_ar,
         i.issue_date, i.due_date, i.status, i.currency, i.subtotal, i.discount_total, i.tax_total, i.total,
         a.allocated, cr.credited, (i.total - a.allocated - cr.credited - wo.written_off)::numeric(14,2) as open_amount,
         case when i.total - a.allocated - cr.credited - wo.written_off > 0 and i.status in ('issued','partially_paid')
              then greatest(core.business_date() - i.due_date, 0) else 0 end as days_overdue,
         (i.total - a.allocated - cr.credited - wo.written_off > 0 and i.status in ('issued','partially_paid')
          and i.due_date < core.business_date()) as is_overdue,
         case when not (i.total - a.allocated - cr.credited - wo.written_off > 0 and i.status in ('issued','partially_paid')) then null
              when core.business_date() - i.due_date <= 0 then 'current'
              when core.business_date() - i.due_date <= 30 then 'd1_30'
              when core.business_date() - i.due_date <= 60 then 'd31_60'
              when core.business_date() - i.due_date <= 90 then 'd61_90'
              else 'd90_plus' end as aging_bucket,
         i.eta_status, i.eta_uuid, i.created_at,
         wo.written_off
  from finance.invoices i
  left join crm.customers c on c.id = i.customer_id
  left join sales.orders o on o.id = i.order_id
  left join lateral crm.employee_display(o.employee_id) rep on true
  cross join lateral (select coalesce(sum(pa.amount), 0)::numeric(14,2) as allocated
                      from finance.payment_allocations pa where pa.invoice_id = i.id) a
  cross join lateral (select coalesce(sum(cn.amount + cn.tax_amount), 0)::numeric(14,2) as credited
                      from finance.credit_notes cn where cn.invoice_id = i.id) cr
  cross join lateral (select coalesce(sum(w.amount), 0)::numeric(14,2) as written_off
                      from finance.invoice_write_offs w where w.invoice_id = i.id) wo;

create or replace view api.v_invoice_write_offs with (security_invoker = true) as
  select w.id, w.write_off_no, w.invoice_id, i.invoice_no, w.customer_id, c.customer_no, c.display_name as customer_name,
         w.amount, w.reason, w.approval_request_id, w.requested_by,
         rq.full_name_en as requested_by_name_en, rq.full_name_ar as requested_by_name_ar,
         w.posted_by, pb.full_name_en as posted_by_name_en, pb.full_name_ar as posted_by_name_ar, w.posted_at
  from finance.invoice_write_offs w
  left join finance.invoices i on i.id = w.invoice_id
  left join crm.customers c on c.id = w.customer_id
  left join lateral core.user_display(w.requested_by) rq on true
  left join lateral core.user_display(w.posted_by) pb on true;

-- Customer block of a printed invoice: only for invoices the caller can read (RLS on invoices
-- and customers); the tax and commercial-register numbers belong on a B2B tax invoice.
create or replace view api.v_invoice_print_party with (security_invoker = true) as
  select i.id as invoice_id, c.id as customer_id, c.customer_no, c.display_name as customer_name,
         c.clinic_name, c.doctor_name, c.address_line, c.city, c.governorate_code,
         g.name_en as governorate_name_en, g.name_ar as governorate_name_ar,
         c.phone_primary::text as phone_primary, c.tax_registration_no, c.commercial_reg_no
  from finance.invoices i
  join crm.customers c on c.id = i.customer_id
  left join core.governorates g on g.code = c.governorate_code;

create or replace view api.v_customer_statement with (security_invoker = true) as
  select l.id as entry_id, l.customer_id, c.customer_no, c.display_name as customer_name,
         l.posted_at, (l.posted_at at time zone 'Africa/Cairo')::date as posted_date,
         l.entry_type, l.source_table, l.source_id,
         coalesce(i.invoice_no, cn.credit_no, p.payment_no, wo.write_off_no) as document_no,
         i.due_date,
         greatest(l.amount, 0)::numeric(14,2) as debit,
         greatest(-l.amount, 0)::numeric(14,2) as credit,
         l.amount,
         (sum(l.amount) over (partition by l.customer_id order by l.posted_at, l.id
                              rows between unbounded preceding and current row))::numeric(14,2) as running_balance
  from finance.customer_ledger l
  left join crm.customers c on c.id = l.customer_id
  left join finance.invoices i on l.source_table = 'finance.invoices' and i.id = l.source_id
  left join finance.credit_notes cn on l.source_table = 'finance.credit_notes' and cn.id = l.source_id
  left join finance.payments p on l.source_table = 'finance.payments' and p.id = l.source_id
  left join finance.invoice_write_offs wo on l.source_table = 'finance.invoice_write_offs' and wo.id = l.source_id;

create or replace view api.v_ar_aging with (security_invoker = true) as
  with gate as (
    select ((select authz.has_permission('finance.page.aging')) or (select authz.has_permission('finance.ledger.read'))) as ok
  ), inv as (
    select i.customer_id, core.business_date() - i.due_date as days,
           (i.total - coalesce((select sum(pa.amount) from finance.payment_allocations pa where pa.invoice_id = i.id), 0)
                    - coalesce((select sum(cn.amount + cn.tax_amount) from finance.credit_notes cn where cn.invoice_id = i.id), 0)
                    - coalesce((select sum(w.amount) from finance.invoice_write_offs w where w.invoice_id = i.id), 0)
           ) as open_amount
    from finance.invoices i, gate
    where gate.ok and i.status in ('issued','partially_paid')
  ), per as (
    select customer_id,
           coalesce(sum(open_amount) filter (where days <= 0), 0) as current_amount,
           coalesce(sum(open_amount) filter (where days between 1 and 30), 0) as d1_30,
           coalesce(sum(open_amount) filter (where days between 31 and 60), 0) as d31_60,
           coalesce(sum(open_amount) filter (where days between 61 and 90), 0) as d61_90,
           coalesce(sum(open_amount) filter (where days > 90), 0) as d90_plus,
           sum(open_amount) as total_open,
           count(*)::int as open_invoices,
           (count(*) filter (where days > 0))::int as overdue_invoices,
           max(days) filter (where days > 0) as max_days_overdue
    from inv where open_amount > 0
    group by customer_id
  ), bal as (
    select l.customer_id, sum(l.amount) as balance
    from finance.customer_ledger l, gate where gate.ok
    group by l.customer_id
  )
  select c.id as customer_id, c.customer_no, c.display_name as customer_name, c.territory_id,
         t.code as territory_code, t.name_en as territory_name_en, t.name_ar as territory_name_ar,
         pr.employee_id as rep_employee_id, rep.full_name_en as rep_name_en, rep.full_name_ar as rep_name_ar,
         coalesce(per.current_amount, 0)::numeric(14,2) as current_amount,
         coalesce(per.d1_30, 0)::numeric(14,2) as d1_30,
         coalesce(per.d31_60, 0)::numeric(14,2) as d31_60,
         coalesce(per.d61_90, 0)::numeric(14,2) as d61_90,
         coalesce(per.d90_plus, 0)::numeric(14,2) as d90_plus,
         coalesce(per.total_open, 0)::numeric(14,2) as total_open,
         coalesce(per.total_open, 0) - coalesce(per.current_amount, 0) as overdue_amount,
         coalesce(per.open_invoices, 0) as open_invoices,
         coalesce(per.overdue_invoices, 0) as overdue_invoices,
         coalesce(per.max_days_overdue, 0) as max_days_overdue,
         coalesce(bal.balance, 0)::numeric(14,2) as ledger_balance,
         greatest(coalesce(per.total_open, 0) - coalesce(bal.balance, 0), 0)::numeric(14,2) as unapplied_credit
  from crm.customers c
  left join per on per.customer_id = c.id
  left join bal on bal.customer_id = c.id
  left join core.territories t on t.id = c.territory_id
  left join lateral (select a.employee_id from crm.customer_assignments a
                     where a.customer_id = c.id and a.role = 'primary_rep' and a.valid_to is null limit 1) pr on true
  left join lateral crm.employee_display(pr.employee_id) rep on true
  where per.customer_id is not null or coalesce(bal.balance, 0) <> 0;

create or replace view api.v_collection_tasks with (security_invoker = true) as
  select t.id, t.customer_id, c.customer_no, c.display_name as customer_name, t.invoice_id, i.invoice_no,
         i.due_date as invoice_due_date,
         case when i.id is not null then
           (i.total - coalesce((select sum(pa.amount) from finance.payment_allocations pa where pa.invoice_id = i.id), 0)
                    - coalesce((select sum(cn.amount + cn.tax_amount) from finance.credit_notes cn where cn.invoice_id = i.id), 0)
                    - coalesce((select sum(w.amount) from finance.invoice_write_offs w where w.invoice_id = i.id), 0)
           )::numeric(14,2) end as invoice_open_amount,
         case when i.id is not null then greatest(core.business_date() - i.due_date, 0) end as days_overdue,
         t.assignee_employee_id, asg.full_name_en as assignee_name_en, asg.full_name_ar as assignee_name_ar,
         t.due_date, t.status, t.promised_amount, t.promised_date,
         (t.status = 'promised' and t.promised_date < core.business_date()) as promise_broken,
         t.outcome, t.work_task_id, t.created_at, t.updated_at, t.closed_at,
         (t.assignee_employee_id = (select authz.current_employee_id())) as is_mine
  from finance.collection_tasks t
  left join crm.customers c on c.id = t.customer_id
  left join finance.invoices i on i.id = t.invoice_id
  left join lateral crm.employee_display(t.assignee_employee_id) asg on true;

-- AR_OVERDUE input (dashboards): starts from 20261031000200; also subtracts write-offs posted
-- by the end of p_as_of, so a partly written-off invoice counts only what is still owed.
create or replace function perf.overdue_invoices(p_as_of date)
returns table (invoice_id uuid, customer_id uuid, due_date date, open_amount numeric)
language sql stable set search_path = '' as $$
  select x.id, x.customer_id, x.due_date, x.open_amount from (
    select i.id, i.customer_id, i.due_date,
           (i.total
            - coalesce((select sum(pa.amount) from finance.payment_allocations pa
                        where pa.invoice_id = i.id and pa.allocated_at < perf.cairo_start(p_as_of + 1)), 0)
            - coalesce((select sum(cn.amount + cn.tax_amount) from finance.credit_notes cn
                        where cn.invoice_id = i.id and cn.issue_date <= p_as_of), 0)
            - coalesce((select sum(w.amount) from finance.invoice_write_offs w
                        where w.invoice_id = i.id and w.posted_at < perf.cairo_start(p_as_of + 1)), 0))::numeric(14,2) as open_amount
    from finance.invoices i
    where i.issue_date <= p_as_of and i.due_date < p_as_of and i.status <> 'written_off'
  ) x where x.open_amount > 0
$$;

-- ---------------------------------------------------------------------------
-- 7. Grants on the views (create or replace keeps existing view ACLs)
-- ---------------------------------------------------------------------------
grant select on api.v_invoice_write_offs, api.v_invoice_print_party to authenticated;
revoke all on api.v_invoice_write_offs, api.v_invoice_print_party from anon;

-- ---------------------------------------------------------------------------
-- 8. Privileges. Explicit (never "all functions in schema api").
-- ---------------------------------------------------------------------------
revoke all on function
  finance.invoice_written_off(uuid),
  wf.on_decided_finance_write_off(uuid, boolean)
from public, anon, authenticated;
-- create or replace keeps ACLs, but restate the internal helpers' revocation.
revoke all on function
  finance.invoice_balance(uuid),
  finance.refresh_invoice_status(uuid)
from public, anon, authenticated;

revoke execute on function
  api.request_invoice_write_off(uuid, numeric, text, text),
  api.company_profile()
from public, anon;
grant execute on function
  api.request_invoice_write_off(uuid, numeric, text, text),
  api.company_profile()
to authenticated;
