-- Honest OS migration: commission engine (DASHBOARDS.md §3, D-05, ADR-022). Tests: suite 37.
--
-- Rules as built (D-05 working decision; owner may change):
--   Basis     collected, VAT-exclusive. A confirmed payment allocation earns on the invoice
--             lines it pays, pro rata to what is still open on each line; the base is the
--             VAT-exclusive share of the money (line net ÷ line total). Bases telescope over
--             the cumulative collected amount, so a fully collected line earns exactly on
--             its net to the cent.
--   Rate      from the employee's commission plan on the event day (an assignment in
--             perf.employee_commission_plans, else the active plan named by the setting
--             commission.default_plan_code). Rules are effective-dated (effective_from /
--             effective_to, inclusive, NULL = open). Most specific wins: variant > category
--             (nearest ancestor first) > brand > plan default (a rule with none set); then
--             the lowest priority value.
--   Earner    the rep on the order (sales.orders.employee_id), never the current customer
--             owner. An invoice without an order earns nothing.
--   Clawback  in the period of the event, never by restating a closed period:
--             · allocation reversal / bounced payment: always; removes the money from the
--               lines pro rata to what each holds, with the commission those lines earned;
--             · credit note: only the part of a line's credit that exceeds the line's still
--               uncollected amount (the credit hits collected money), and only within
--               commission.clawback_days (90) of the invoice's latest standing collection.
--               That collected money then pays the invoice's other open lines (they earn at
--               their rate on the credit-note day). An amount-only (goodwill) credit is
--               spread over the open amounts and so never claws back.
--   Periods   calendar months (Cairo). service.commission_calculate is idempotent and
--             deterministic: it replays each invoice's history and merges the period's rows
--             (unchanged rows keep their ids). api.close_commission_period freezes the oldest
--             open month after it ended (status 'approved'); the cron closes a month at
--             perf.period_close_at (day 6 of the next month, like KPIs). Frozen rows are
--             immutable (triggers). An event that reaches the database after its month froze
--             is posted in the first open month.
--   Adjust    api.adjust_commission → workflow 'perf.commission_adjustment'; the decision hook
--             posts the adjustment (wf.on_decided_perf_commission_adjustment; dispatcher branch
--             in 20261103000499_dispatch.sql).
--   Not used  perf.commission_plans.min_achievement_pct (D-05: no threshold).
--
-- Non-destructive: new nullable columns, a widened period-status guard, new policies on
-- tables that had none (deny-by-default until now), new functions, views and a setting.

-- ---------------------------------------------------------------------------
-- 0. Schema additions (expand only) and a setting
-- ---------------------------------------------------------------------------
alter table perf.commission_plan_rules add column if not exists effective_from date;
alter table perf.commission_plan_rules add column if not exists effective_to date;
alter table perf.commission_plan_rules add constraint commission_plan_rules_effective_check
  check (effective_from is null or effective_to is null or effective_to >= effective_from);
create index if not exists idx_commission_rules_plan on perf.commission_plan_rules (plan_id);

alter table perf.commission_entries add column if not exists entry_kind text
  check (entry_kind in ('collection','reversal','bounce','credit_clawback','credit_reattribution'));
alter table perf.commission_entries add column if not exists event_at timestamptz;
alter table perf.commission_entries add column if not exists event_date date;
alter table perf.commission_entries add column if not exists invoice_id uuid references finance.invoices(id);
alter table perf.commission_entries add column if not exists customer_id uuid references crm.customers(id);
-- Display snapshot of the source documents (invoice/order/payment/credit numbers, customer,
-- SKU), so a statement keeps showing them after the customer is reassigned.
alter table perf.commission_entries add column if not exists snapshot jsonb not null default '{}';
create index if not exists idx_commission_entries_period on perf.commission_entries (period_id, employee_id);
create index if not exists idx_commission_entries_source on perf.commission_entries (source_type, source_id);

alter table perf.commission_adjustments add column if not exists idempotency_key text unique;
create index if not exists idx_commission_adjustments_period on perf.commission_adjustments (period_id, employee_id);

alter table perf.commission_periods add column if not exists last_run_id uuid;

create index if not exists idx_employee_commission_plans_emp on perf.employee_commission_plans (employee_id, valid_from desc);

insert into core.system_settings (key, value, description) values
  ('commission.default_plan_code', '"STD-2026"',
   'Commission plan used for employees without a plan assignment (only while that plan is active)')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Integrity guards
-- ---------------------------------------------------------------------------
create or replace function perf.commission_status_frozen(p_status text) returns boolean
language sql immutable set search_path = '' as $$
  select p_status in ('approved','paid','locked')
$$;

-- Entries are engine output: never edited; inserted or removed only while their period is open.
create or replace function perf.guard_commission_entry() returns trigger
language plpgsql set search_path = '' as $$
declare v_status text;
begin
  if tg_op = 'UPDATE' then
    raise exception 'COMMISSION_ENTRY_IMMUTABLE: entries are recalculated, never edited' using errcode = 'P0001';
  end if;
  select status into v_status from perf.commission_periods
   where id = case when tg_op = 'DELETE' then old.period_id else new.period_id end;
  if perf.commission_status_frozen(v_status) then
    raise exception 'PERIOD_CLOSED: commission period is %', v_status using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger trg_commission_entries_guard before insert or update or delete on perf.commission_entries
  for each row execute function perf.guard_commission_entry();

-- Adjustments are append-only and never land in a frozen period.
create or replace function perf.guard_commission_adjustment() returns trigger
language plpgsql set search_path = '' as $$
declare v_status text;
begin
  select status into v_status from perf.commission_periods where id = new.period_id;
  if perf.commission_status_frozen(v_status) then
    raise exception 'PERIOD_CLOSED: commission period is %', v_status using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger trg_commission_adjustments_guard before insert on perf.commission_adjustments
  for each row execute function perf.guard_commission_adjustment();
create trigger trg_commission_adjustments_append_only before update or delete on perf.commission_adjustments
  for each row execute function core.forbid_mutation();

-- A period moves forward only: open ⇄ calculated → approved → paid → locked. Never deleted.
create or replace function perf.guard_commission_period() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_rank_old int := array_position(array['open','calculated','approved','paid','locked'], old.status);
  v_rank_new int := array_position(array['open','calculated','approved','paid','locked'], new.status);
begin
  if (new.period_start, new.period_end) is distinct from (old.period_start, old.period_end) then
    raise exception 'VALIDATION: a commission period''s dates never change' using errcode = 'P0001';
  end if;
  if perf.commission_status_frozen(old.status) then
    if v_rank_new < v_rank_old
       or (new.calculated_at, new.approved_by, new.approved_at, new.last_run_id)
          is distinct from (old.calculated_at, old.approved_by, old.approved_at, old.last_run_id) then
      raise exception 'PERIOD_CLOSED: commission period is %', old.status using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
create trigger trg_commission_periods_guard before update on perf.commission_periods
  for each row execute function perf.guard_commission_period();
create trigger trg_commission_periods_no_delete before delete on perf.commission_periods
  for each row execute function core.forbid_mutation();

-- ---------------------------------------------------------------------------
-- 2. Building blocks (internal; never client-callable, except the view helper in §6)
-- ---------------------------------------------------------------------------
-- One engine at a time: calculation, close and adjustment posting serialize on this lock.
create or replace function perf.commission_lock() returns void
language sql volatile security definer set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('perf.commission.engine', 0))
$$;

-- The month row of p_day (created when missing), locked for update.
create or replace function perf.commission_period_row(p_day date) returns perf.commission_periods
language plpgsql volatile security definer set search_path = '' as $$
declare v_start date := date_trunc('month', p_day)::date; v_row perf.commission_periods%rowtype;
begin
  insert into perf.commission_periods (period_start, period_end)
  values (v_start, (v_start + interval '1 month' - interval '1 day')::date)
  on conflict (period_start, period_end) do nothing;
  select * into v_row from perf.commission_periods
   where period_start = v_start and period_end = (v_start + interval '1 month' - interval '1 day')::date
   for update;
  return v_row;
end $$;

-- The oldest month that may still change: the month after the latest frozen one, or else the
-- earliest month with commission activity or a period row (capped at the current month).
create or replace function perf.commission_first_open_month() returns date
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select (max(p.period_end) + 1) from perf.commission_periods p where perf.commission_status_frozen(p.status)),
    least(date_trunc('month', core.business_date())::date,
          coalesce((select date_trunc('month', min(x.d))::date from (
                      select min((a.allocated_at at time zone 'Africa/Cairo')::date) as d from finance.payment_allocations a
                      union all select min(cn.issue_date) from finance.credit_notes cn
                      union all select min(p.period_start) from perf.commission_periods p) x),
                   date_trunc('month', core.business_date())::date)))
$$;

-- Split an amount over weights (2 dp); the rounding remainder goes to the largest weight.
create or replace function perf.split_amount(p_amount numeric, p_weights numeric[]) returns numeric[]
language plpgsql immutable set search_path = '' as $$
declare
  n int := coalesce(array_length(p_weights, 1), 0); i int; v_sum numeric := 0; v_acc numeric := 0;
  v_best int; v_w numeric; v_out numeric[] := '{}';
begin
  for i in 1..n loop v_sum := v_sum + greatest(coalesce(p_weights[i], 0), 0); end loop;
  for i in 1..n loop
    v_w := greatest(coalesce(p_weights[i], 0), 0);
    if v_sum <= 0 or coalesce(p_amount, 0) = 0 then
      v_out[i] := 0;
    else
      v_out[i] := round(p_amount * v_w / v_sum, 2);
      if v_w > 0 and (v_best is null or v_w > greatest(coalesce(p_weights[v_best], 0), 0)) then v_best := i; end if;
    end if;
    v_acc := v_acc + v_out[i];
  end loop;
  if v_best is not null then v_out[v_best] := v_out[v_best] + (p_amount - v_acc); end if;
  return v_out;
end $$;

-- The employee's plan on a day: the latest assignment covering the day (if its plan is active
-- then), else the active default plan (setting commission.default_plan_code). NULL = none.
create or replace function perf.commission_plan_for(p_employee_id uuid, p_day date) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_plan uuid; v_found boolean;
begin
  select ep.plan_id into v_plan from perf.employee_commission_plans ep
   where ep.employee_id = p_employee_id and ep.valid_from <= p_day and (ep.valid_to is null or ep.valid_to >= p_day)
   order by ep.valid_from desc limit 1;
  v_found := found;
  if not v_found then
    select p.id into v_plan from perf.commission_plans p
     where p.code = (select s.value #>> '{}' from core.system_settings s where s.key = 'commission.default_plan_code');
  end if;
  return (select p.id from perf.commission_plans p
           where p.id = v_plan and p.status = 'active' and p.effective_from <= p_day
             and (p.effective_to is null or p.effective_to >= p_day));
end $$;

-- The rule and rate in force for a variant on a day. No matching rule → (NULL, NULL).
create or replace function perf.commission_rate(p_plan_id uuid, p_variant_id uuid, p_day date,
                                                out o_rule_id uuid, out o_rate_pct numeric)
language sql stable security definer set search_path = '' as $$
  with recursive v as (
    select pv.id as variant_id, p.brand_id, p.category_id
    from catalog.product_variants pv join catalog.products p on p.id = pv.product_id
    where pv.id = p_variant_id
  ), cats as (
    select c.id, c.parent_id, 0 as depth from catalog.categories c join v on c.id = v.category_id
    union all
    select c.id, c.parent_id, cats.depth + 1 from catalog.categories c join cats on c.id = cats.parent_id
    where cats.depth < 10
  )
  select r.id, r.rate_pct
  from perf.commission_plan_rules r
  cross join v
  left join cats on cats.id = r.category_id
  where r.plan_id = p_plan_id
    and (r.effective_from is null or r.effective_from <= p_day)
    and (r.effective_to is null or r.effective_to >= p_day)
    and (r.variant_id is null or r.variant_id = v.variant_id)
    and (r.category_id is null or cats.id is not null)
    and (r.brand_id is null or r.brand_id = v.brand_id)
  order by (r.variant_id is not null) desc, (r.category_id is not null) desc, cats.depth nulls last,
           (r.brand_id is not null) desc, r.priority, r.effective_from desc nulls last, r.id
  limit 1
$$;

-- ---------------------------------------------------------------------------
-- 3. The engine: replay one invoice's history in order and emit the rows of one period
-- ---------------------------------------------------------------------------
-- Per line it tracks collected gross (incl. VAT), credited gross and the commission standing
-- on it. An event is "frozen" when its rows sit in a frozen period (their stored commission is
-- what counts), or when it predates the orphan window of the latest frozen month. Rows go to
-- the event's month, or to the first open month for a late event of a frozen month.
create or replace function perf.commission_replay_invoice(p_invoice_id uuid, p_period_id uuid, p_period_start date,
                                                          p_period_end date, p_last_frozen_end date, p_orphan_from date,
                                                          p_clawback_days int, p_run_id uuid)
returns int language plpgsql volatile security definer set search_path = '' as $$
declare
  v_inv record; ev record; v_r record;
  v_ids uuid[]; v_var uuid[]; v_tot numeric[]; v_net numeric[]; v_sku text[]; v_desc text[];
  v_coll numeric[]; v_cred numeric[]; v_comm numeric[]; v_lplan uuid[];
  v_dcoll numeric[]; v_dcred numeric[]; v_dcomm numeric[]; v_rule uuid[]; v_rate numeric[]; v_kind text[];
  v_w numeric[]; v_split numeric[]; v_over numeric;
  v_st_ids uuid[] := '{}'; v_st_dates date[] := '{}';
  n int; i int; v_pos int; v_rows int := 0;
  v_plan uuid; v_frozen boolean; v_emit boolean; v_acct date; v_stored numeric; v_base numeric;
  v_sum numeric; v_total_over numeric; v_line_plan uuid; v_line_rate numeric; v_has_items boolean;
begin
  select i.id, i.invoice_no, i.customer_id, o.employee_id as rep_id, o.order_no, c.display_name as customer_name
    into v_inv
  from finance.invoices i
  join sales.orders o on o.id = i.order_id
  left join crm.customers c on c.id = i.customer_id
  where i.id = p_invoice_id;
  if not found then return 0; end if;

  select array_agg(ii.id order by ii.id), array_agg(ii.variant_id order by ii.id),
         array_agg(ii.line_total order by ii.id), array_agg((ii.line_total - ii.tax_amount) order by ii.id),
         array_agg(pv.sku order by ii.id), array_agg(ii.description order by ii.id)
    into v_ids, v_var, v_tot, v_net, v_sku, v_desc
  from finance.invoice_items ii
  left join catalog.product_variants pv on pv.id = ii.variant_id
  where ii.invoice_id = p_invoice_id and ii.line_total > 0;
  n := coalesce(array_length(v_ids, 1), 0);
  if n = 0 then return 0; end if;
  v_coll := array_fill(0::numeric, array[n]); v_cred := v_coll; v_comm := v_coll;
  v_lplan := array_fill(null::uuid, array[n]);

  for ev in
    select x.* from (
      select 'payment_allocation'::text as source_type, a.id, a.allocated_at as ts,
             (a.allocated_at at time zone 'Africa/Cairo')::date as day, a.amount::numeric as amount,
             null::uuid as reverses, p.payment_no as doc_no, p.status as payment_status, 1 as ord
      from finance.payment_allocations a join finance.payments p on p.id = a.payment_id
      where a.invoice_id = p_invoice_id and a.amount > 0
      union all
      select 'allocation_reversal', a.id, a.allocated_at, (a.allocated_at at time zone 'Africa/Cairo')::date,
             -a.amount, a.reverses_allocation_id, p.payment_no, p.status, 2
      from finance.payment_allocations a join finance.payments p on p.id = a.payment_id
      where a.invoice_id = p_invoice_id and a.amount < 0
      union all
      select 'credit_note', cn.id, cn.created_at, cn.issue_date, (cn.amount + cn.tax_amount)::numeric,
             null, cn.credit_no, null, 0
      from finance.credit_notes cn where cn.invoice_id = p_invoice_id
    ) x
    where x.day <= p_period_end
    order by x.ts, x.ord, x.id
  loop
    v_frozen := exists (select 1 from perf.commission_entries e join perf.commission_periods cp on cp.id = e.period_id
                        where e.source_type = ev.source_type and e.source_id = ev.id
                          and perf.commission_status_frozen(cp.status));
    if not v_frozen and p_last_frozen_end is not null and ev.day <= p_last_frozen_end and ev.day < p_orphan_from then
      v_frozen := true;          -- settled long ago with no rows (e.g. no plan then): stays at zero
    end if;
    v_acct := case when p_last_frozen_end is not null and ev.day <= p_last_frozen_end
                   then (p_last_frozen_end + 1) else date_trunc('month', ev.day)::date end;
    v_emit := not v_frozen and v_acct = p_period_start;

    v_dcoll := array_fill(0::numeric, array[n]); v_dcred := v_dcoll; v_dcomm := v_dcoll; v_rate := v_dcoll;
    v_rule := array_fill(null::uuid, array[n]); v_kind := array_fill(null::text, array[n]);
    v_plan := perf.commission_plan_for(v_inv.rep_id, ev.day);

    if ev.source_type = 'payment_allocation' then
      -- Collection: pays the lines pro rata to what is still open on each.
      v_sum := 0;
      for i in 1..n loop v_w[i] := greatest(v_tot[i] - v_coll[i] - v_cred[i], 0); v_sum := v_sum + v_w[i]; end loop;
      v_split := perf.split_amount(least(ev.amount, v_sum), v_w[1:n]);
      for i in 1..n loop
        continue when v_split[i] <= 0;
        v_dcoll[i] := v_split[i]; v_kind[i] := 'collection';
      end loop;
      v_st_ids := v_st_ids || ev.id; v_st_dates := v_st_dates || ev.day;

    elsif ev.source_type = 'allocation_reversal' then
      -- Reversal / bounce: the money leaves the lines pro rata to what each holds.
      v_pos := array_position(v_st_ids, ev.reverses);
      if v_pos is not null then
        v_st_ids := v_st_ids[:v_pos - 1] || v_st_ids[v_pos + 1:];
        v_st_dates := v_st_dates[:v_pos - 1] || v_st_dates[v_pos + 1:];
      end if;
      v_sum := 0;
      for i in 1..n loop v_sum := v_sum + v_coll[i]; end loop;
      v_split := perf.split_amount(least(ev.amount, v_sum), v_coll);
      for i in 1..n loop
        v_over := least(v_split[i], v_coll[i]);
        continue when v_over <= 0;
        v_dcoll[i] := -v_over;
        v_kind[i] := case when ev.payment_status = 'bounced' then 'bounce' else 'reversal' end;
        v_dcomm[i] := -(case when v_over >= v_coll[i] then v_comm[i] else round(v_comm[i] * v_over / v_coll[i], 2) end);
      end loop;

    else
      -- Credit note: credited gross per line (lines from its items; an amount-only note is
      -- spread over the open amounts).
      v_has_items := exists (select 1 from finance.credit_note_items ci where ci.credit_note_id = ev.id);
      if v_has_items then
        for i in 1..n loop
          select coalesce(sum(ci.amount + ci.tax_amount), 0) into v_stored
          from finance.credit_note_items ci where ci.credit_note_id = ev.id and ci.invoice_item_id = v_ids[i];
          v_dcred[i] := v_stored;
        end loop;
      else
        v_sum := 0;
        for i in 1..n loop v_w[i] := greatest(v_tot[i] - v_coll[i] - v_cred[i], 0); v_sum := v_sum + v_w[i]; end loop;
        v_dcred := perf.split_amount(ev.amount, case when v_sum > 0 then v_w[1:n] else v_tot end);
      end if;

      if coalesce(array_length(v_st_dates, 1), 0) > 0
         and ev.day - (select max(d) from unnest(v_st_dates) d) <= p_clawback_days then
        v_total_over := 0;
        for i in 1..n loop
          v_over := least(greatest(v_dcred[i] - greatest(v_tot[i] - v_coll[i] - v_cred[i], 0), 0), v_coll[i]);
          continue when v_over <= 0;
          v_dcoll[i] := -v_over; v_kind[i] := 'credit_clawback';
          v_dcomm[i] := -(case when v_over >= v_coll[i] then v_comm[i] else round(v_comm[i] * v_over / v_coll[i], 2) end);
          v_total_over := v_total_over + v_over;
        end loop;
        if v_total_over > 0 then
          -- The clawed-back money now pays the invoice's other open lines.
          v_sum := 0;
          for i in 1..n loop
            v_w[i] := greatest(v_tot[i] - (v_coll[i] + v_dcoll[i]) - (v_cred[i] + v_dcred[i]), 0); v_sum := v_sum + v_w[i];
          end loop;
          v_split := perf.split_amount(least(v_total_over, v_sum), v_w[1:n]);
          for i in 1..n loop
            continue when v_split[i] <= 0 or v_kind[i] is not null;
            v_dcoll[i] := v_split[i]; v_kind[i] := 'credit_reattribution';
          end loop;
        end if;
      end if;
    end if;

    -- Bases, rates and the rows of this period.
    for i in 1..n loop
      continue when v_kind[i] is null;
      v_base := round((v_coll[i] + v_dcoll[i]) * v_net[i] / v_tot[i], 2) - round(v_coll[i] * v_net[i] / v_tot[i], 2);
      if v_kind[i] in ('collection','credit_reattribution') then
        if v_plan is not null then
          select * into v_r from perf.commission_rate(v_plan, v_var[i], ev.day);
          v_rule[i] := v_r.o_rule_id; v_rate[i] := coalesce(v_r.o_rate_pct, 0);
        end if;
        v_dcomm[i] := round(v_base * v_rate[i] / 100, 2);
        v_line_plan := v_plan; v_line_rate := v_rate[i];
      else
        v_line_plan := coalesce(v_plan, v_lplan[i]);
        v_line_rate := case when v_base <> 0 then least(round(abs(v_dcomm[i] / v_base) * 100, 2), 100) else 0 end;
      end if;
      if v_emit and v_line_plan is not null and (v_base <> 0 or v_dcomm[i] <> 0) then
        insert into pg_temp.commission_calc (period_id, employee_id, plan_id, rule_id, source_type, source_id,
                                             invoice_item_id, base_amount, rate_pct, commission_amount, calc_run_id,
                                             entry_kind, event_at, event_date, invoice_id, customer_id, snapshot)
        values (p_period_id, v_inv.rep_id, v_line_plan, v_rule[i], ev.source_type, ev.id, v_ids[i], v_base,
                v_line_rate, v_dcomm[i], p_run_id, v_kind[i], ev.ts, ev.day, v_inv.id, v_inv.customer_id,
                jsonb_strip_nulls(jsonb_build_object(
                  'invoice_no', v_inv.invoice_no, 'order_no', v_inv.order_no, 'customer_name', v_inv.customer_name,
                  'sku', v_sku[i], 'description', v_desc[i], 'document_no', ev.doc_no,
                  'reverses_allocation_id', ev.reverses)));
        v_rows := v_rows + 1;
      end if;
    end loop;

    -- State after the event; a frozen event counts with the commission actually posted.
    for i in 1..n loop
      if v_frozen then
        select coalesce(sum(e.commission_amount), 0) into v_stored from perf.commission_entries e
         where e.source_type = ev.source_type and e.source_id = ev.id and e.invoice_item_id = v_ids[i];
        v_comm[i] := v_comm[i] + v_stored;
      else
        v_comm[i] := v_comm[i] + v_dcomm[i];
      end if;
      v_coll[i] := v_coll[i] + v_dcoll[i];
      v_cred[i] := v_cred[i] + v_dcred[i];
      if v_kind[i] in ('collection','credit_reattribution') and v_plan is not null then v_lplan[i] := v_plan; end if;
    end loop;
  end loop;
  return v_rows;
end $$;

-- ---------------------------------------------------------------------------
-- 4. service.commission_calculate (service_role only): idempotent, deterministic
-- ---------------------------------------------------------------------------
create or replace function service.commission_calculate(p_period date)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_start date; v_end date; v_p perf.commission_periods%rowtype; v_run uuid := gen_random_uuid();
  v_last_frozen_end date; v_orphan_from date; v_days int; v_inv uuid; v_invoices int := 0;
  v_deleted int := 0; v_inserted int := 0; v_changed boolean;
begin
  if p_period is null then raise exception 'VALIDATION: a period is required' using errcode = 'P0001'; end if;
  v_start := date_trunc('month', p_period)::date;
  v_end := (v_start + interval '1 month' - interval '1 day')::date;
  if v_start > date_trunc('month', core.business_date())::date then
    raise exception 'VALIDATION: the period has not started' using errcode = 'P0001';
  end if;

  perform perf.commission_lock();
  v_p := perf.commission_period_row(v_start);
  if perf.commission_status_frozen(v_p.status) then
    return jsonb_build_object('period_id', v_p.id, 'period_start', v_start, 'status', v_p.status, 'frozen', true,
                              'changed', false, 'inserted', 0, 'deleted', 0, 'invoices', 0, 'run_id', v_p.last_run_id,
                              'entries', (select count(*) from perf.commission_entries where period_id = v_p.id),
                              'total', (select coalesce(sum(commission_amount), 0) from perf.commission_entries where period_id = v_p.id));
  end if;
  select max(p.period_end) into v_last_frozen_end from perf.commission_periods p where perf.commission_status_frozen(p.status);
  if v_last_frozen_end is not null and v_start <= v_last_frozen_end then
    raise exception 'INVALID_STATE: an open period cannot precede a closed one' using errcode = 'P0001';
  end if;
  v_orphan_from := case when v_last_frozen_end is not null then date_trunc('month', v_last_frozen_end)::date end;
  v_days := greatest(coalesce((select (s.value #>> '{}')::int from core.system_settings s where s.key = 'commission.clawback_days'), 90), 0);

  -- Scratch rows of this run (one temp table per session, dropped at commit).
  if to_regclass('pg_temp.commission_calc') is null then
    create temp table commission_calc (
      period_id uuid, employee_id uuid, plan_id uuid, rule_id uuid, source_type text, source_id uuid,
      invoice_item_id uuid, base_amount numeric(14,2), rate_pct numeric(5,2), commission_amount numeric(14,2),
      calc_run_id uuid, entry_kind text, event_at timestamptz, event_date date, invoice_id uuid, customer_id uuid,
      snapshot jsonb
    ) on commit drop;
  end if;
  truncate pg_temp.commission_calc;

  for v_inv in
    select distinct ev.invoice_id from (
      select a.invoice_id, (a.allocated_at at time zone 'Africa/Cairo')::date as day from finance.payment_allocations a
      union all
      select cn.invoice_id, cn.issue_date from finance.credit_notes cn
    ) ev
    where ev.day between v_start and v_end
       or (v_start = v_last_frozen_end + 1 and ev.day between v_orphan_from and v_last_frozen_end)
    order by ev.invoice_id
  loop
    perform perf.commission_replay_invoice(v_inv, v_p.id, v_start, v_end, v_last_frozen_end, v_orphan_from, v_days, v_run);
    v_invoices := v_invoices + 1;
  end loop;

  -- Merge: rows that did not change keep their id and run id; the rest are replaced.
  with del as (
    delete from perf.commission_entries e
    where e.period_id = v_p.id
      and not exists (
        select 1 from pg_temp.commission_calc c
        where (c.employee_id, c.plan_id, c.rule_id, c.source_type, c.source_id, c.invoice_item_id, c.base_amount,
               c.rate_pct, c.commission_amount, c.entry_kind, c.event_at, c.event_date, c.invoice_id, c.customer_id, c.snapshot)
              is not distinct from
              (e.employee_id, e.plan_id, e.rule_id, e.source_type, e.source_id, e.invoice_item_id, e.base_amount::numeric(14,2),
               e.rate_pct, e.commission_amount::numeric(14,2), e.entry_kind, e.event_at, e.event_date, e.invoice_id, e.customer_id, e.snapshot))
    returning 1
  )
  select count(*) into v_deleted from del;

  insert into perf.commission_entries (period_id, employee_id, plan_id, rule_id, source_type, source_id, invoice_item_id,
                                       base_amount, rate_pct, commission_amount, calc_run_id, entry_kind, event_at,
                                       event_date, invoice_id, customer_id, snapshot)
  select c.period_id, c.employee_id, c.plan_id, c.rule_id, c.source_type, c.source_id, c.invoice_item_id,
         c.base_amount, c.rate_pct, c.commission_amount, c.calc_run_id, c.entry_kind, c.event_at,
         c.event_date, c.invoice_id, c.customer_id, c.snapshot
  from pg_temp.commission_calc c
  where not exists (
    select 1 from perf.commission_entries e
    where e.period_id = v_p.id and e.source_type = c.source_type and e.source_id = c.source_id
      and e.invoice_item_id = c.invoice_item_id and e.employee_id = c.employee_id);
  get diagnostics v_inserted = row_count;

  v_changed := v_deleted + v_inserted > 0;
  if v_changed or v_p.status = 'open' then
    update perf.commission_periods
       set status = 'calculated', calculated_at = now(), last_run_id = case when v_changed then v_run else last_run_id end
     where id = v_p.id
    returning * into v_p;
  end if;

  return jsonb_build_object('period_id', v_p.id, 'period_start', v_start, 'period_end', v_end, 'status', v_p.status,
                            'frozen', false, 'changed', v_changed, 'inserted', v_inserted, 'deleted', v_deleted,
                            'invoices', v_invoices, 'run_id', v_p.last_run_id,
                            'entries', (select count(*) from perf.commission_entries where period_id = v_p.id),
                            'total', (select coalesce(sum(commission_amount), 0) from perf.commission_entries where period_id = v_p.id));
end $$;

-- ---------------------------------------------------------------------------
-- 5. Close (freeze) a period — shared by the command and the cron
-- ---------------------------------------------------------------------------
create or replace function perf.commission_close(p_period date, p_closed_by uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_start date := date_trunc('month', p_period)::date; v_end date; v_first date; v_p perf.commission_periods%rowtype;
  v_calc jsonb; v_emp uuid; v_label text; v_total numeric; v_adj numeric; v_employees int;
begin
  v_end := (v_start + interval '1 month' - interval '1 day')::date;
  perform perf.commission_lock();
  select * into v_p from perf.commission_periods where period_start = v_start and period_end = v_end;
  if found and perf.commission_status_frozen(v_p.status) then
    return jsonb_build_object('period_id', v_p.id, 'period_start', v_start, 'status', v_p.status, 'replayed', true);
  end if;
  if v_end >= core.business_date() then
    raise exception 'PERIOD_NOT_ENDED: the period ends on %', v_end using errcode = 'P0001';
  end if;
  v_first := perf.commission_first_open_month();
  if v_start > v_first then
    raise exception 'PREVIOUS_PERIOD_OPEN: close % first', to_char(v_first, 'YYYY-MM') using errcode = 'P0001';
  elsif v_start < v_first then
    raise exception 'INVALID_STATE: only the oldest open period (%) can be closed', to_char(v_first, 'YYYY-MM')
      using errcode = 'P0001';
  end if;

  v_calc := service.commission_calculate(v_start);          -- final calculation, same transaction
  update perf.commission_periods set status = 'approved', approved_by = p_closed_by, approved_at = now()
   where period_start = v_start and period_end = v_end
  returning * into v_p;

  select coalesce(sum(commission_amount), 0) into v_total from perf.commission_entries where period_id = v_p.id;
  select coalesce(sum(amount), 0) into v_adj from perf.commission_adjustments where period_id = v_p.id;
  v_label := to_char(v_start, 'YYYY-MM');
  v_employees := 0;
  for v_emp in
    select employee_id from perf.commission_entries where period_id = v_p.id
    union select employee_id from perf.commission_adjustments where period_id = v_p.id
  loop
    v_employees := v_employees + 1;
    perform crm._notify_employee(v_emp, 'commission.statement_final', 'Commission statement final: ' || v_label,
                                 null, '/commissions?period=' || v_label,
                                 jsonb_build_object('period_id', v_p.id, 'period_start', v_start));
  end loop;
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('commission.period_closed', 'perf.commission_period', v_p.id,
          jsonb_build_object('period_id', v_p.id, 'period_start', v_start, 'period_end', v_end,
                             'entries_total', v_total, 'adjustments_total', v_adj, 'total', v_total + v_adj,
                             'employees', v_employees, 'currency', 'EGP'));
  return jsonb_build_object('period_id', v_p.id, 'period_start', v_start, 'period_end', v_end, 'status', v_p.status,
                            'entries_total', v_total, 'adjustments_total', v_adj, 'total', v_total + v_adj,
                            'employees', v_employees, 'calculation', v_calc, 'replayed', false);
end $$;

-- Cron (service_role): close every month whose close time (perf.period_close_at) has passed,
-- oldest first, then recalculate the open months up to the current one.
create or replace function service.commission_run(p_now timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_now timestamptz := coalesce(p_now, now()); v_cur date := date_trunc('month', core.business_date())::date;
  v_first date; v_closed text[] := '{}'; v_calculated text[] := '{}'; v_m date; v_changed int := 0; v_res jsonb;
begin
  loop
    v_first := perf.commission_first_open_month();
    exit when v_first >= v_cur or perf.period_close_at(v_first) > v_now;
    perform perf.commission_close(v_first, null);
    v_closed := v_closed || to_char(v_first, 'YYYY-MM');
  end loop;
  v_m := perf.commission_first_open_month();
  while v_m <= v_cur loop
    v_res := service.commission_calculate(v_m);
    v_calculated := v_calculated || to_char(v_m, 'YYYY-MM');
    if (v_res ->> 'changed')::boolean then v_changed := v_changed + 1; end if;
    v_m := (v_m + interval '1 month')::date;
  end loop;
  return jsonb_build_object('closed', to_jsonb(v_closed), 'calculated', to_jsonb(v_calculated), 'changed', v_changed);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Commands
-- ---------------------------------------------------------------------------
-- Recalculate an open month now (finance's "refresh"); the same engine the cron runs.
create or replace function api.calculate_commission_period(p_period date)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform authz.require('perf.commission.calculate');
  if not authz.has_global('perf.commission.calculate') then
    raise exception 'PERMISSION_DENIED: commission periods are company-wide' using errcode = '42501';
  end if;
  return service.commission_calculate(p_period);
end $$;

-- Freeze the oldest open month once it has ended: final calculation, then status 'approved'.
-- A replay of a frozen month returns it unchanged.
create or replace function api.close_commission_period(p_period date)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform authz.require('perf.commission.calculate');
  if not authz.has_global('perf.commission.calculate') then
    raise exception 'PERMISSION_DENIED: commission periods are company-wide' using errcode = '42501';
  end if;
  if p_period is null then raise exception 'VALIDATION: a period is required' using errcode = 'P0001'; end if;
  return perf.commission_close(p_period, auth.uid());
end $$;

-- Request a bonus, clawback or correction for one employee and month. Always through the
-- 'perf.commission_adjustment' workflow; the decision hook posts it. Nobody adjusts their own
-- commission; the requester can never approve their own request (api.decide_approval).
create or replace function api.adjust_commission(p_employee_id uuid, p_period date, p_amount numeric, p_reason text,
                                                 p_kind text default null, p_idempotency_key text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_key text := nullif(btrim(p_idempotency_key), ''); v_reason text := nullif(btrim(p_reason), '');
  v_kind text := lower(coalesce(nullif(btrim(p_kind), ''), case when p_amount < 0 then 'clawback' else 'bonus' end));
  v_start date; v_status text; v_adj perf.commission_adjustments%rowtype; v_req wf.approval_requests%rowtype;
  v_id uuid := gen_random_uuid(); v_request uuid; v_emp core.employees%rowtype; v_territory uuid;
begin
  perform authz.require('perf.commission.adjust');
  if v_key is null or length(v_key) > 100 then
    raise exception 'VALIDATION: idempotency key is required' using errcode = 'P0001';
  end if;
  select * into v_emp from core.employees where id = p_employee_id;
  if not found then raise exception 'NOT_FOUND: employee %', p_employee_id using errcode = 'P0002'; end if;
  if not (authz.has_global('perf.commission.adjust') or p_employee_id = any(authz.employee_ids('perf.commission.adjust'))) then
    raise exception 'PERMISSION_DENIED: employee not in your scope' using errcode = '42501';
  end if;
  if p_employee_id = authz.current_employee_id() then
    raise exception 'SELF_ADJUSTMENT: you cannot adjust your own commission' using errcode = '42501';
  end if;

  -- Replays: the posted adjustment, or the request deciding it.
  select * into v_adj from perf.commission_adjustments where idempotency_key = v_key;
  if found then
    if v_adj.employee_id <> p_employee_id then
      raise exception 'IDEMPOTENCY_CONFLICT: key was used for another adjustment' using errcode = 'P0001';
    end if;
    return jsonb_build_object('adjustment_id', v_adj.id, 'status', 'posted', 'approval_request_id', v_adj.approval_request_id,
                              'amount', v_adj.amount, 'replayed', true);
  end if;
  select r.* into v_req from wf.approval_requests r join wf.workflow_definitions d on d.id = r.definition_id
   where d.code = 'perf.commission_adjustment' and r.payload ->> 'idempotency_key' = v_key
   order by r.created_at desc limit 1;
  if found then
    if core.jsonb_uuid(v_req.payload, 'employee_id') is distinct from p_employee_id then
      raise exception 'IDEMPOTENCY_CONFLICT: key was used for another adjustment' using errcode = 'P0001';
    end if;
    return jsonb_build_object('adjustment_id', v_req.entity_id,
                              'status', case v_req.status when 'pending' then 'pending_approval' when 'approved' then 'posted' else v_req.status end,
                              'approval_request_id', v_req.id, 'amount', (v_req.payload ->> 'amount')::numeric, 'replayed', true);
  end if;

  if v_reason is null or length(v_reason) < 3 then
    raise exception 'REASON_REQUIRED: an adjustment needs a reason' using errcode = 'P0001';
  end if;
  if length(v_reason) > 500 then raise exception 'VALIDATION: reason is too long' using errcode = 'P0001'; end if;
  if p_amount is null or p_amount = 0 or p_amount <> round(p_amount, 2) or abs(p_amount) > 1000000 then
    raise exception 'VALIDATION: amount must be non-zero with at most 2 decimals' using errcode = 'P0001';
  end if;
  if v_kind not in ('bonus','clawback','correction')
     or (v_kind = 'bonus' and p_amount < 0) or (v_kind = 'clawback' and p_amount > 0) then
    raise exception 'VALIDATION: a bonus is positive, a clawback negative' using errcode = 'P0001';
  end if;
  if p_period is null then raise exception 'VALIDATION: a period is required' using errcode = 'P0001'; end if;
  v_start := date_trunc('month', p_period)::date;
  if v_start > date_trunc('month', core.business_date())::date then
    raise exception 'VALIDATION: the period has not started' using errcode = 'P0001';
  end if;
  select status into v_status from perf.commission_periods where period_start = v_start;
  if perf.commission_status_frozen(v_status) or v_start < perf.commission_first_open_month() then
    raise exception 'PERIOD_CLOSED: % is closed; adjust an open period', to_char(v_start, 'YYYY-MM') using errcode = 'P0001';
  end if;
  select et.territory_id into v_territory from core.employee_territories et
   where et.employee_id = p_employee_id and et.valid_to is null order by et.territory_id limit 1;

  v_request := wf.create_request('perf.commission_adjustment', 'perf.commission_adjustment', v_id,
    jsonb_build_object('adjustment_id', v_id, 'employee_id', p_employee_id, 'employee_no', v_emp.employee_no,
                       'employee_name', v_emp.full_name_en, 'period_start', v_start, 'amount', p_amount,
                       'kind', v_kind, 'reason', v_reason, 'idempotency_key', v_key, 'currency', 'EGP',
                       'territory_id', v_territory, 'limit_metric', abs(p_amount)),
    p_employee_id);
  return jsonb_build_object('adjustment_id', v_id, 'approval_request_id', v_request, 'amount', p_amount, 'kind', v_kind,
                            'status', case when exists (select 1 from perf.commission_adjustments where id = v_id)
                                           then 'posted' else 'pending_approval' end,
                            'replayed', false);
end $$;

-- Decision hook: post the approved adjustment (re-checked against the period as it is now).
create or replace function wf.on_decided_perf_commission_adjustment(p_request_id uuid, p_approved boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare r wf.approval_requests%rowtype; v_p perf.commission_periods%rowtype; v_emp uuid; v_amount numeric;
begin
  select * into r from wf.approval_requests where id = p_request_id;
  if not p_approved then return; end if;
  if exists (select 1 from perf.commission_adjustments where id = r.entity_id) then return; end if;
  perform perf.commission_lock();
  v_p := perf.commission_period_row((r.payload ->> 'period_start')::date);
  if perf.commission_status_frozen(v_p.status) or v_p.period_start < perf.commission_first_open_month() then
    raise exception 'PERIOD_CLOSED: the period closed since this adjustment was requested; reject and request again'
      using errcode = 'P0001';
  end if;
  v_emp := core.jsonb_uuid(r.payload, 'employee_id');
  v_amount := (r.payload ->> 'amount')::numeric;
  insert into perf.commission_adjustments (id, period_id, employee_id, amount, kind, reason, approval_request_id,
                                           created_by, idempotency_key)
  values (r.entity_id, v_p.id, v_emp, v_amount, r.payload ->> 'kind', r.payload ->> 'reason', r.id,
          r.requested_by, r.payload ->> 'idempotency_key');
  perform crm._notify_employee(v_emp, 'commission.adjusted', 'Commission adjustment: ' || to_char(v_p.period_start, 'YYYY-MM'),
                               r.payload ->> 'reason', '/commissions?period=' || to_char(v_p.period_start, 'YYYY-MM'),
                               jsonb_build_object('adjustment_id', r.entity_id, 'amount', v_amount));
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('commission.adjusted', 'perf.commission_adjustment', r.entity_id,
          jsonb_build_object('adjustment_id', r.entity_id, 'employee_id', v_emp, 'period_start', v_p.period_start,
                             'amount', v_amount, 'kind', r.payload ->> 'kind', 'currency', 'EGP'));
end $$;

-- ---------------------------------------------------------------------------
-- 7. Read access: policies on tables that had none, a name helper, views
-- ---------------------------------------------------------------------------
create policy commission_periods_select on perf.commission_periods for select to authenticated using (
  (select authz.has_permission('perf.commission.read')) or (select authz.has_permission('perf.commission.calculate'))
);
create policy commission_adjustments_select on perf.commission_adjustments for select to authenticated using (
  (select authz.has_global('perf.commission.read'))
  or employee_id = any((select authz.employee_ids('perf.commission.read'))::uuid[])
);

-- Name of an employee whose commission the caller may read or adjust (NULL otherwise). Reps hold
-- no core.employee.read, and finance reads commissions of everyone.
create or replace function perf.commission_employee(p_employee_id uuid)
returns table (employee_no text, full_name_en text, full_name_ar text)
language sql stable security definer set search_path = '' as $$
  select e.employee_no, e.full_name_en, e.full_name_ar from core.employees e
  where e.id = p_employee_id
    and (authz.has_global('perf.commission.read') or e.id = any(authz.employee_ids('perf.commission.read'))
         or authz.has_global('perf.commission.adjust') or e.id = any(authz.employee_ids('perf.commission.adjust')))
$$;

create or replace view api.v_commission_periods with (security_invoker = true) as
select p.id, p.period_start, p.period_end, p.status,
       perf.commission_status_frozen(p.status) as is_frozen,
       (((p.period_start + interval '1 month' + interval '5 days')::date)::timestamp at time zone 'Africa/Cairo') as closes_at,
       p.calculated_at, p.approved_at as closed_at,
       coalesce(e.total, 0)::numeric(14,2) as entries_total,
       coalesce(e.cnt, 0)::int as entry_count,
       coalesce(a.total, 0)::numeric(14,2) as adjustments_total,
       (coalesce(e.total, 0) + coalesce(a.total, 0))::numeric(14,2) as total,
       coalesce(u.n, 0)::int as employee_count
from perf.commission_periods p
left join lateral (select sum(x.commission_amount) as total, count(*) as cnt
                   from perf.commission_entries x where x.period_id = p.id) e on true
left join lateral (select sum(x.amount) as total from perf.commission_adjustments x where x.period_id = p.id) a on true
left join lateral (select count(*) as n from (select x.employee_id from perf.commission_entries x where x.period_id = p.id
                                              union select x.employee_id from perf.commission_adjustments x where x.period_id = p.id) y) u on true;

create or replace view api.v_commission_statement with (security_invoker = true) as
select 'entry'::text as line_type, e.id, e.period_id, p.period_start, p.period_end, p.status as period_status,
       e.employee_id, emp.employee_no, emp.full_name_en as employee_name_en, emp.full_name_ar as employee_name_ar,
       e.entry_kind as kind, e.source_type, e.source_id, e.invoice_id, e.invoice_item_id, e.customer_id,
       e.snapshot ->> 'invoice_no' as invoice_no, e.snapshot ->> 'order_no' as order_no,
       e.snapshot ->> 'customer_name' as customer_name, e.snapshot ->> 'sku' as sku,
       e.snapshot ->> 'description' as description, e.snapshot ->> 'document_no' as document_no,
       e.base_amount::numeric(14,2) as base_amount, e.rate_pct, e.commission_amount::numeric(14,2) as amount,
       e.event_at, e.event_date, null::text as reason, null::uuid as approval_request_id, e.created_at
from perf.commission_entries e
join perf.commission_periods p on p.id = e.period_id
left join lateral perf.commission_employee(e.employee_id) emp on true
union all
select 'adjustment'::text, a.id, a.period_id, p.period_start, p.period_end, p.status,
       a.employee_id, emp.employee_no, emp.full_name_en, emp.full_name_ar,
       a.kind, null::text, null::uuid, null::uuid, null::uuid, null::uuid,
       null::text, null::text, null::text, null::text, null::text, null::text,
       null::numeric(14,2), null::numeric(5,2), a.amount::numeric(14,2),
       a.created_at, (a.created_at at time zone 'Africa/Cairo')::date, a.reason, a.approval_request_id, a.created_at
from perf.commission_adjustments a
join perf.commission_periods p on p.id = a.period_id
left join lateral perf.commission_employee(a.employee_id) emp on true;

-- One row per (period, employee) the caller can read: earned, clawed back, adjustments, total.
create or replace view api.v_commission_summary with (security_invoker = true) as
select s.period_id, p.period_start, p.period_end, p.status as period_status, s.employee_id,
       emp.employee_no, emp.full_name_en as employee_name_en, emp.full_name_ar as employee_name_ar,
       s.earned::numeric(14,2) as earned, s.clawed_back::numeric(14,2) as clawed_back,
       s.adjustments::numeric(14,2) as adjustments, s.total::numeric(14,2) as total,
       s.base_total::numeric(14,2) as base_total, s.entry_count::int as entry_count
from (
  select l.period_id, l.employee_id,
         sum(l.earned) as earned, sum(l.clawed) as clawed_back, sum(l.adjusted) as adjustments,
         sum(l.amount) as total, sum(l.base) as base_total, count(*) filter (where l.is_entry) as entry_count
  from (
    select x.period_id, x.employee_id, x.commission_amount as amount, x.base_amount as base, true as is_entry,
           case when x.entry_kind in ('collection','credit_reattribution') then x.commission_amount else 0 end as earned,
           case when x.entry_kind in ('collection','credit_reattribution') then 0 else x.commission_amount end as clawed,
           0::numeric as adjusted
    from perf.commission_entries x
    union all
    select x.period_id, x.employee_id, x.amount, 0, false, 0, 0, x.amount from perf.commission_adjustments x
  ) l
  group by l.period_id, l.employee_id
) s
join perf.commission_periods p on p.id = s.period_id
left join lateral perf.commission_employee(s.employee_id) emp on true;

-- Adjustment requests the caller made or whose employee's commission they may read.
create or replace view api.v_commission_adjustment_requests with (security_invoker = true) as
select r.id as request_id, r.entity_id as adjustment_id, r.status, r.created_at, r.decided_at,
       (r.requested_by = (select auth.uid())) as is_mine,
       core.jsonb_uuid(r.payload, 'employee_id') as employee_id, emp.employee_no,
       emp.full_name_en as employee_name_en, emp.full_name_ar as employee_name_ar,
       (r.payload ->> 'period_start')::date as period_start, (r.payload ->> 'amount')::numeric(14,2) as amount,
       r.payload ->> 'kind' as kind, r.payload ->> 'reason' as reason
from wf.approval_requests r
join wf.workflow_definitions d on d.id = r.definition_id
left join lateral perf.commission_employee(core.jsonb_uuid(r.payload, 'employee_id')) emp on true
where d.code = 'perf.commission_adjustment'
  and (r.requested_by = (select auth.uid()) or emp.employee_no is not null);

grant select on api.v_commission_periods, api.v_commission_statement, api.v_commission_summary,
                api.v_commission_adjustment_requests to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Privileges (explicit; never "all functions in schema")
-- ---------------------------------------------------------------------------
revoke execute on function
  perf.commission_status_frozen(text),
  perf.guard_commission_entry(),
  perf.guard_commission_adjustment(),
  perf.guard_commission_period(),
  perf.commission_lock(),
  perf.commission_period_row(date),
  perf.commission_first_open_month(),
  perf.split_amount(numeric, numeric[]),
  perf.commission_plan_for(uuid, date),
  perf.commission_rate(uuid, uuid, date),
  perf.commission_replay_invoice(uuid, uuid, date, date, date, date, int, uuid),
  perf.commission_close(date, uuid),
  perf.commission_employee(uuid),
  wf.on_decided_perf_commission_adjustment(uuid, boolean)
from public, anon, authenticated;
-- Needed by the views (security_invoker: evaluated as the caller).
grant execute on function perf.commission_status_frozen(text) to authenticated;
grant execute on function perf.commission_employee(uuid) to authenticated;

revoke all on function service.commission_calculate(date) from public, anon, authenticated;
revoke all on function service.commission_run(timestamptz) from public, anon, authenticated;
grant execute on function service.commission_calculate(date) to service_role;
grant execute on function service.commission_run(timestamptz) to service_role;

revoke execute on function
  api.calculate_commission_period(date),
  api.close_commission_period(date),
  api.adjust_commission(uuid, date, numeric, text, text, text)
from public, anon;
grant execute on function
  api.calculate_commission_period(date),
  api.close_commission_period(date),
  api.adjust_commission(uuid, date, numeric, text, text, text)
to authenticated;
