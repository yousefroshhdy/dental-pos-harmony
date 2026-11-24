-- Honest OS migration: Phase P step 7, commissions switched on (owner decision D, D-05).
-- Tests: suite 58 (58_phase_p_commissions.test.sql). Engine: 20261103000400_commissions.sql and
-- 20261104000100_audit4_returns_ar.sql §7 (latest replay), both kept as they were except the
-- changes listed here.
--
--   1. Rate editor (owner only, MFA). perf.commission_plan.manage (seeded 20261028001500, held by
--      no role: owners only) now requires MFA. Commands:
--        api.create_commission_plan       a new draft plan (code, name; basis collected)
--        api.set_commission_rate          a rate for the plan default, a brand, a category or a
--                                         variant from an effective date (NULL rate = no rate
--                                         from that date). Append-only: the rate in force is
--                                         closed the day before (effective_to); a rate that had
--                                         not started yet is voided. Nothing in a closed month
--                                         ever changes.
--        api.activate_commission_plan     draft → active from an effective date; assigns every
--                                         active sales rep (role sales_rep) to the plan from that
--                                         date (perf.employee_commission_plans)
--        api.deactivate_commission_plan   active → retired from the day after an end date; ends
--                                         the plan's assignments that day
--      Specificity is unchanged: variant > category (nearest ancestor) > brand > plan default.
--   2. Integrity: rules are immutable except effective_to (closing) and voiding, and neither may
--      reach into a closed (frozen) commission month; plans move draft → active → retired only,
--      and an active plan's code, basis and start date never change. Every change is audited
--      (audit.log_change on plans and rules already; added on employee_commission_plans).
--   3. Engine: a retired plan still applies to the days it covered (it used to drop out of open
--      months entirely); voided rules and cancelled assignments are ignored; each entry stores
--      the gross money (incl. VAT) it moved (gross_amount) for the rep statement. Zero-value
--      (bonus/free) lines never take part: the replay reads only lines with line_total > 0.
--   4. Decision D configuration of STD-2026 (stays DRAFT): brand rules BIONER 5 %, DERBY 1.5 %,
--      RDT 1.5 % next to the seeded category rules (IMPLANT 5 %, BUR 1.5 %, INSTRUMENT 1.5 %).
--      Bone grafts and membranes (category GRAFT/MEMBRANE, brand STEP) get no rule: they earn
--      0 and show in the editor's "no rate" list until the owner sets one. Activation is the
--      owner's own step in the editor (MFA, audited with his identity, his effective date); a
--      migration has no actor and could not be gated, so it does not activate.
--   5. Reads: api.v_commission_plans, api.v_commission_plan_rules (perf.commission_plan.read or
--      .manage), api.commission_unrated(plan, day) (variants with no rate), and
--      api.v_commission_statement_totals (the rep statement: collected cash → commissionable
--      amount excl. VAT → commission → clawbacks → net), scoped by perf.commission.read like
--      the other statement views (rep own, area manager team, finance/director/owner all).
--
-- Non-destructive: new nullable columns, new policies, guards, functions and views. CREATE OR
-- REPLACE keeps privileges; they are restated at the end.

-- ---------------------------------------------------------------------------
-- 0. Schema additions (expand only)
-- ---------------------------------------------------------------------------
alter table perf.commission_plans add column if not exists created_at timestamptz not null default now();
alter table perf.commission_plans add column if not exists activated_at timestamptz;
alter table perf.commission_plans add column if not exists activated_by uuid references auth.users(id);
alter table perf.commission_plans add column if not exists retired_at timestamptz;
alter table perf.commission_plans add column if not exists retired_by uuid references auth.users(id);
alter table perf.commission_plans add column if not exists retire_reason text;
create index if not exists idx_commission_plans_activated_by on perf.commission_plans (activated_by);
create index if not exists idx_commission_plans_retired_by on perf.commission_plans (retired_by);

alter table perf.commission_plan_rules add column if not exists created_at timestamptz not null default now();
alter table perf.commission_plan_rules add column if not exists created_by uuid references auth.users(id);
alter table perf.commission_plan_rules add column if not exists voided_at timestamptz;
alter table perf.commission_plan_rules add column if not exists voided_by uuid references auth.users(id);
alter table perf.commission_plan_rules add column if not exists note text;
alter table perf.commission_plan_rules add column if not exists idempotency_key text unique;
create index if not exists idx_commission_plan_rules_created_by on perf.commission_plan_rules (created_by);
create index if not exists idx_commission_plan_rules_voided_by on perf.commission_plan_rules (voided_by);

alter table perf.employee_commission_plans add column if not exists id uuid not null default gen_random_uuid();
alter table perf.employee_commission_plans add constraint employee_commission_plans_id_key unique (id);
alter table perf.employee_commission_plans add column if not exists created_at timestamptz not null default now();
alter table perf.employee_commission_plans add column if not exists created_by uuid references auth.users(id);
alter table perf.employee_commission_plans add column if not exists cancelled_at timestamptz;
alter table perf.employee_commission_plans add column if not exists cancelled_by uuid references auth.users(id);
create index if not exists idx_employee_commission_plans_created_by on perf.employee_commission_plans (created_by);
create index if not exists idx_employee_commission_plans_cancelled_by on perf.employee_commission_plans (cancelled_by);
create trigger trg_audit after insert or update or delete on perf.employee_commission_plans
  for each row execute function audit.log_change();

-- Gross money (incl. VAT) the event moved on the line: + collected, − reversed / clawed back.
alter table perf.commission_entries add column if not exists gross_amount numeric(14,2);

update authz.permissions set requires_mfa = true
 where code = 'perf.commission_plan.manage' and not requires_mfa;

-- ---------------------------------------------------------------------------
-- 1. Integrity guards
-- ---------------------------------------------------------------------------
-- Last day of the latest frozen (closed) commission month; NULL while none is closed.
create or replace function perf.commission_last_frozen_end() returns date
language sql stable security definer set search_path = '' as $$
  select max(p.period_end) from perf.commission_periods p where perf.commission_status_frozen(p.status)
$$;

-- Rules: append-only. Only closing (effective_to) and voiding are allowed, and neither, nor an
-- insert or a delete, may change what applied on a day of a closed month.
create or replace function perf.guard_commission_rule() returns trigger
language plpgsql set search_path = '' as $$
declare v_frozen date := perf.commission_last_frozen_end(); v_status text;
begin
  if tg_op = 'INSERT' then
    select p.status into v_status from perf.commission_plans p where p.id = new.plan_id;
    if v_status = 'retired' then
      raise exception 'INVALID_STATE: a retired plan takes no new rate' using errcode = 'P0001';
    end if;
    if v_frozen is not null and (new.effective_from is null or new.effective_from <= v_frozen) then
      raise exception 'PERIOD_CLOSED: a rate cannot start in a closed commission month (closed to %)', v_frozen
        using errcode = 'P0001';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if v_frozen is not null and (old.effective_from is null or old.effective_from <= v_frozen) then
      raise exception 'PERIOD_CLOSED: a rate used by a closed commission month is never deleted' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if (new.id, new.plan_id, new.brand_id, new.category_id, new.variant_id, new.rate_pct, new.priority,
      new.effective_from, new.created_at, new.created_by, new.note, new.idempotency_key)
     is distinct from
     (old.id, old.plan_id, old.brand_id, old.category_id, old.variant_id, old.rate_pct, old.priority,
      old.effective_from, old.created_at, old.created_by, old.note, old.idempotency_key) then
    raise exception 'COMMISSION_RULE_IMMUTABLE: a rate is never edited; set a new rate from a date' using errcode = 'P0001';
  end if;
  if old.voided_at is not null
     and (new.voided_at, new.voided_by, new.effective_to) is distinct from (old.voided_at, old.voided_by, old.effective_to) then
    raise exception 'COMMISSION_RULE_IMMUTABLE: a void rate stays void' using errcode = 'P0001';
  end if;
  if old.voided_at is null and new.voided_at is null and new.voided_by is distinct from old.voided_by then
    raise exception 'COMMISSION_RULE_IMMUTABLE: voided_by is set with voided_at' using errcode = 'P0001';
  end if;
  if old.voided_at is null and new.voided_at is not null and v_frozen is not null
     and (old.effective_from is null or old.effective_from <= v_frozen) then
    raise exception 'PERIOD_CLOSED: a rate used by a closed commission month cannot be voided' using errcode = 'P0001';
  end if;
  -- Moving the end from A to B changes the days between them: all must be after the closed months.
  if new.effective_to is distinct from old.effective_to and v_frozen is not null
     and least(coalesce(old.effective_to, 'infinity'::date), coalesce(new.effective_to, 'infinity'::date)) < v_frozen then
    raise exception 'PERIOD_CLOSED: a rate''s end cannot move into a closed commission month' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger trg_commission_rules_guard before insert or update or delete on perf.commission_plan_rules
  for each row execute function perf.guard_commission_rule();

-- Plans: draft → active → retired. A draft is free to change (it earned nothing). An active or
-- retired plan keeps its code, basis and start; its end is set once, by retiring it, never
-- inside a closed month. Only drafts may be deleted.
create or replace function perf.guard_commission_plan() returns trigger
language plpgsql set search_path = '' as $$
declare v_frozen date;
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'COMMISSION_PLAN_IMMUTABLE: an active or retired plan is never deleted' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if old.status = 'draft' then
    if new.status not in ('draft','active') then
      raise exception 'INVALID_STATE: a draft plan can only be activated' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if (new.code, new.basis, new.effective_from, new.min_achievement_pct, new.activated_at, new.activated_by, new.created_at)
     is distinct from
     (old.code, old.basis, old.effective_from, old.min_achievement_pct, old.activated_at, old.activated_by, old.created_at) then
    raise exception 'COMMISSION_PLAN_IMMUTABLE: an active plan''s code, basis and start never change' using errcode = 'P0001';
  end if;
  if (old.status = 'active' and new.status not in ('active','retired')) or (old.status = 'retired' and new.status <> 'retired') then
    raise exception 'INVALID_STATE: a plan moves draft → active → retired' using errcode = 'P0001';
  end if;
  if old.status = 'retired'
     and (new.effective_to, new.retired_at, new.retired_by, new.retire_reason)
         is distinct from (old.effective_to, old.retired_at, old.retired_by, old.retire_reason) then
    raise exception 'COMMISSION_PLAN_IMMUTABLE: a retired plan never changes' using errcode = 'P0001';
  end if;
  if new.effective_to is distinct from old.effective_to then
    if new.status <> 'retired' or new.effective_to is null then
      raise exception 'COMMISSION_PLAN_IMMUTABLE: an active plan''s end is set by retiring it' using errcode = 'P0001';
    end if;
    v_frozen := perf.commission_last_frozen_end();
    if v_frozen is not null and least(coalesce(old.effective_to, 'infinity'::date), new.effective_to) < v_frozen then
      raise exception 'PERIOD_CLOSED: a plan''s end cannot move into a closed commission month' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
create trigger trg_commission_plans_guard before update or delete on perf.commission_plans
  for each row execute function perf.guard_commission_plan();

-- ---------------------------------------------------------------------------
-- 2. Plan and rate lookup — from 20261103000400 §2. Changes: a retired plan applies to the days
--    it covered; cancelled assignments and voided rules are ignored.
-- ---------------------------------------------------------------------------
-- The employee's plan on a day: the latest assignment covering the day (if its plan is in
-- force then), else the default plan (setting commission.default_plan_code). NULL = none.
create or replace function perf.commission_plan_for(p_employee_id uuid, p_day date) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_plan uuid; v_found boolean;
begin
  select ep.plan_id into v_plan from perf.employee_commission_plans ep
   where ep.employee_id = p_employee_id and ep.cancelled_at is null
     and ep.valid_from <= p_day and (ep.valid_to is null or ep.valid_to >= p_day)
   order by ep.valid_from desc limit 1;
  v_found := found;
  if not v_found then
    select p.id into v_plan from perf.commission_plans p
     where p.code = (select s.value #>> '{}' from core.system_settings s where s.key = 'commission.default_plan_code');
  end if;
  return (select p.id from perf.commission_plans p
           where p.id = v_plan and p.status in ('active','retired') and p.effective_from <= p_day
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
    and r.voided_at is null
    and (r.variant_id is null or r.variant_id = v.variant_id)
    and (r.category_id is null or cats.id is not null)
    and (r.brand_id is null or r.brand_id = v.brand_id)
  order by (r.variant_id is not null) desc, (r.category_id is not null) desc, cats.depth nulls last,
           (r.brand_id is not null) desc, r.priority, r.effective_from desc nulls last, r.id
  limit 1
$$;


-- ---------------------------------------------------------------------------
-- 3. Engine — perf.commission_replay_invoice from 20261104000100 §7 and service.commission_calculate
--    from 20261103000400 §4. Change: each row stores the gross money it moved (gross_amount =
--    the line's collected delta), carried through the scratch table and the merge.
-- ---------------------------------------------------------------------------
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
      where a.invoice_id = p_invoice_id and a.amount > 0 and a.credit_note_id is null
      union all
      select 'allocation_reversal', a.id, a.allocated_at, (a.allocated_at at time zone 'Africa/Cairo')::date,
             -a.amount, a.reverses_allocation_id, p.payment_no, p.status, 2
      from finance.payment_allocations a join finance.payments p on p.id = a.payment_id
      where a.invoice_id = p_invoice_id and a.amount < 0 and a.credit_note_id is null
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
                                             entry_kind, event_at, event_date, invoice_id, customer_id, snapshot,
                                             gross_amount)
        values (p_period_id, v_inv.rep_id, v_line_plan, v_rule[i], ev.source_type, ev.id, v_ids[i], v_base,
                v_line_rate, v_dcomm[i], p_run_id, v_kind[i], ev.ts, ev.day, v_inv.id, v_inv.customer_id,
                jsonb_strip_nulls(jsonb_build_object(
                  'invoice_no', v_inv.invoice_no, 'order_no', v_inv.order_no, 'customer_name', v_inv.customer_name,
                  'sku', v_sku[i], 'description', v_desc[i], 'document_no', ev.doc_no,
                  'reverses_allocation_id', ev.reverses)),
                v_dcoll[i]);
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
      snapshot jsonb, gross_amount numeric(14,2)
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
               c.rate_pct, c.commission_amount, c.entry_kind, c.event_at, c.event_date, c.invoice_id, c.customer_id, c.snapshot,
               c.gross_amount)
              is not distinct from
              (e.employee_id, e.plan_id, e.rule_id, e.source_type, e.source_id, e.invoice_item_id, e.base_amount::numeric(14,2),
               e.rate_pct, e.commission_amount::numeric(14,2), e.entry_kind, e.event_at, e.event_date, e.invoice_id, e.customer_id, e.snapshot,
               e.gross_amount))
    returning 1
  )
  select count(*) into v_deleted from del;

  insert into perf.commission_entries (period_id, employee_id, plan_id, rule_id, source_type, source_id, invoice_item_id,
                                       base_amount, rate_pct, commission_amount, calc_run_id, entry_kind, event_at,
                                       event_date, invoice_id, customer_id, snapshot, gross_amount)
  select c.period_id, c.employee_id, c.plan_id, c.rule_id, c.source_type, c.source_id, c.invoice_item_id,
         c.base_amount, c.rate_pct, c.commission_amount, c.calc_run_id, c.entry_kind, c.event_at,
         c.event_date, c.invoice_id, c.customer_id, c.snapshot, c.gross_amount
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
-- 4. Rate editor commands (owner only: perf.commission_plan.manage, company-wide, MFA)
-- ---------------------------------------------------------------------------
-- The earliest day a plan or rate change may take effect is perf.commission_first_open_month():
-- the first day of the oldest month that is not closed. Closed months never change.
create or replace function perf.require_plan_manager() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  perform authz.require('perf.commission_plan.manage');
  if not authz.has_global('perf.commission_plan.manage') then
    raise exception 'PERMISSION_DENIED: commission plans are company-wide' using errcode = '42501';
  end if;
end $$;

-- A new draft plan. Basis is collected cash (D-05). Replays return the existing plan.
create or replace function api.create_commission_plan(p_code text, p_name text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_code text := upper(btrim(coalesce(p_code, ''))); v_name text := btrim(coalesce(p_name, ''));
        v_plan perf.commission_plans%rowtype;
begin
  perform perf.require_plan_manager();
  if v_code !~ '^[A-Z0-9][A-Z0-9_-]{1,39}$' then
    raise exception 'VALIDATION: a plan code is 2–40 letters, digits, - or _' using errcode = 'P0001';
  end if;
  if length(v_name) < 3 or length(v_name) > 120 then
    raise exception 'VALIDATION: a plan name is 3–120 characters' using errcode = 'P0001';
  end if;
  select * into v_plan from perf.commission_plans where code = v_code;
  if found then
    if v_plan.name = v_name then
      return jsonb_build_object('plan_id', v_plan.id, 'code', v_plan.code, 'status', v_plan.status, 'replayed', true);
    end if;
    raise exception 'DUPLICATE: plan code % exists', v_code using errcode = 'P0001';
  end if;
  insert into perf.commission_plans (code, name, basis, effective_from, status)
  values (v_code, v_name, 'collected', core.business_date(), 'draft')
  returning * into v_plan;
  return jsonb_build_object('plan_id', v_plan.id, 'code', v_plan.code, 'status', v_plan.status, 'replayed', false);
end $$;

-- Set (or, with p_rate_pct NULL, remove) the rate of one target from p_effective_from on.
--   p_target  'default' (p_target_id NULL) | 'brand' | 'category' | 'variant'
-- Append-only: the target's rate in force on p_effective_from is closed the day before; a rate
-- of the target that starts on or after p_effective_from is voided (it never applied). A new
-- row carries the new rate. Repeating the same change is a replay.
create or replace function api.set_commission_rate(p_plan_id uuid, p_target text, p_target_id uuid, p_rate_pct numeric,
                                                   p_effective_from date, p_note text default null,
                                                   p_idempotency_key text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_target text := lower(btrim(coalesce(p_target, ''))); v_key text := nullif(btrim(p_idempotency_key), '');
  v_note text := nullif(btrim(p_note), ''); v_plan perf.commission_plans%rowtype;
  v_brand uuid; v_cat uuid; v_var uuid; v_min date; r perf.commission_plan_rules%rowtype;
  v_closed int := 0; v_voided int := 0; v_id uuid;
begin
  perform perf.require_plan_manager();
  if v_target not in ('default','brand','category','variant') then
    raise exception 'VALIDATION: target is default, brand, category or variant' using errcode = 'P0001';
  end if;
  if (v_target = 'default') <> (p_target_id is null) then
    raise exception 'VALIDATION: the plan default takes no target; the others need one' using errcode = 'P0001';
  end if;
  if p_rate_pct is not null and (p_rate_pct < 0 or p_rate_pct > 100 or p_rate_pct <> round(p_rate_pct, 2)) then
    raise exception 'VALIDATION: a rate is 0–100 %% with at most 2 decimals' using errcode = 'P0001';
  end if;
  if p_effective_from is null then
    raise exception 'VALIDATION: an effective date is required' using errcode = 'P0001';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'VALIDATION: the note is too long' using errcode = 'P0001';
  end if;
  if v_key is not null and length(v_key) > 100 then
    raise exception 'VALIDATION: idempotency key is too long' using errcode = 'P0001';
  end if;

  perform perf.commission_lock();
  select * into v_plan from perf.commission_plans where id = p_plan_id for update;
  if not found then raise exception 'NOT_FOUND: commission plan %', p_plan_id using errcode = 'P0002'; end if;
  if v_plan.status = 'retired' then
    raise exception 'INVALID_STATE: a retired plan takes no new rate' using errcode = 'P0001';
  end if;

  if v_target = 'brand' then
    select b.id into v_brand from catalog.brands b where b.id = p_target_id;
    if v_brand is null then raise exception 'NOT_FOUND: brand %', p_target_id using errcode = 'P0002'; end if;
  elsif v_target = 'category' then
    select c.id into v_cat from catalog.categories c where c.id = p_target_id;
    if v_cat is null then raise exception 'NOT_FOUND: category %', p_target_id using errcode = 'P0002'; end if;
  elsif v_target = 'variant' then
    select v.id into v_var from catalog.product_variants v where v.id = p_target_id;
    if v_var is null then raise exception 'NOT_FOUND: product %', p_target_id using errcode = 'P0002'; end if;
  end if;

  -- Replays: the same key, or the same rate already in force from the same day.
  if v_key is not null then
    select * into r from perf.commission_plan_rules where idempotency_key = v_key;
    if found then
      if (r.plan_id, r.brand_id, r.category_id, r.variant_id, r.rate_pct, r.effective_from)
         is not distinct from (p_plan_id, v_brand, v_cat, v_var, p_rate_pct, p_effective_from) then
        return jsonb_build_object('rule_id', r.id, 'plan_id', p_plan_id, 'target', v_target, 'target_id', p_target_id,
                                  'rate_pct', r.rate_pct, 'effective_from', r.effective_from, 'closed', 0, 'voided', 0,
                                  'replayed', true);
      end if;
      raise exception 'IDEMPOTENCY_CONFLICT: key was used for another rate' using errcode = 'P0001';
    end if;
  end if;
  select * into r from perf.commission_plan_rules x
   where x.plan_id = p_plan_id and x.voided_at is null
     and x.brand_id is not distinct from v_brand and x.category_id is not distinct from v_cat
     and x.variant_id is not distinct from v_var
     and (x.effective_from is null or x.effective_from <= p_effective_from)
     and (x.effective_to is null or x.effective_to >= p_effective_from)
   order by x.effective_from desc nulls last limit 1;
  if p_rate_pct is not null and found and r.rate_pct = p_rate_pct and r.effective_to is null
     and r.effective_from is not distinct from p_effective_from then
    return jsonb_build_object('rule_id', r.id, 'plan_id', p_plan_id, 'target', v_target, 'target_id', p_target_id,
                              'rate_pct', r.rate_pct, 'effective_from', r.effective_from, 'closed', 0, 'voided', 0,
                              'replayed', true);
  end if;

  v_min := perf.commission_first_open_month();
  if p_effective_from < v_min then
    raise exception 'PERIOD_CLOSED: a rate can take effect from % at the earliest (earlier months are closed)', v_min
      using errcode = 'P0001';
  end if;
  if p_effective_from > core.business_date() + 366 then
    raise exception 'VALIDATION: the effective date is more than a year ahead' using errcode = 'P0001';
  end if;

  for r in
    select * from perf.commission_plan_rules x
     where x.plan_id = p_plan_id and x.voided_at is null
       and x.brand_id is not distinct from v_brand and x.category_id is not distinct from v_cat
       and x.variant_id is not distinct from v_var
       and (x.effective_to is null or x.effective_to >= p_effective_from)
     for update
  loop
    if r.effective_from is not null and r.effective_from >= p_effective_from then
      update perf.commission_plan_rules set voided_at = now(), voided_by = auth.uid() where id = r.id;
      v_voided := v_voided + 1;
    else
      update perf.commission_plan_rules set effective_to = p_effective_from - 1 where id = r.id;
      v_closed := v_closed + 1;
    end if;
  end loop;

  if p_rate_pct is not null then
    insert into perf.commission_plan_rules (plan_id, brand_id, category_id, variant_id, rate_pct, priority,
                                            effective_from, created_by, note, idempotency_key)
    values (p_plan_id, v_brand, v_cat, v_var, p_rate_pct, 50, p_effective_from, auth.uid(), v_note, v_key)
    returning id into v_id;
  end if;

  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('commission.rate_changed', 'perf.commission_plan', p_plan_id,
          jsonb_build_object('plan_id', p_plan_id, 'plan_code', v_plan.code, 'rule_id', v_id, 'target', v_target,
                             'target_id', p_target_id, 'rate_pct', p_rate_pct, 'effective_from', p_effective_from));
  return jsonb_build_object('rule_id', v_id, 'plan_id', p_plan_id, 'target', v_target, 'target_id', p_target_id,
                            'rate_pct', p_rate_pct, 'effective_from', p_effective_from, 'closed', v_closed,
                            'voided', v_voided, 'replayed', false);
end $$;

-- Draft → active from p_effective_from (no earlier than the oldest open month). With
-- p_assign_sales_reps, every active employee holding the sales_rep role who has no plan
-- assignment on that day is assigned to this plan from that day. Employees without an
-- assignment earn on the default plan (setting commission.default_plan_code) anyway.
create or replace function api.activate_commission_plan(p_plan_id uuid, p_effective_from date,
                                                        p_assign_sales_reps boolean default true)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_plan perf.commission_plans%rowtype; v_min date; v_assigned int := 0;
begin
  perform perf.require_plan_manager();
  if p_effective_from is null then
    raise exception 'VALIDATION: an effective date is required' using errcode = 'P0001';
  end if;
  perform perf.commission_lock();
  select * into v_plan from perf.commission_plans where id = p_plan_id for update;
  if not found then raise exception 'NOT_FOUND: commission plan %', p_plan_id using errcode = 'P0002'; end if;
  if v_plan.status = 'active' and v_plan.effective_from = p_effective_from then
    return jsonb_build_object('plan_id', v_plan.id, 'code', v_plan.code, 'status', v_plan.status,
                              'effective_from', v_plan.effective_from, 'assigned', 0, 'replayed', true);
  end if;
  if v_plan.status <> 'draft' then
    raise exception 'INVALID_STATE: only a draft plan can be activated (this one is %)', v_plan.status using errcode = 'P0001';
  end if;
  v_min := perf.commission_first_open_month();
  if p_effective_from < v_min then
    raise exception 'PERIOD_CLOSED: the plan can start on % at the earliest (earlier months are closed)', v_min
      using errcode = 'P0001';
  end if;
  if p_effective_from > core.business_date() + 366 then
    raise exception 'VALIDATION: the effective date is more than a year ahead' using errcode = 'P0001';
  end if;
  if not exists (select 1 from perf.commission_plan_rules r where r.plan_id = p_plan_id and r.voided_at is null) then
    raise exception 'VALIDATION: set at least one rate before activating the plan' using errcode = 'P0001';
  end if;

  update perf.commission_plans
     set status = 'active', effective_from = p_effective_from, effective_to = null,
         activated_at = now(), activated_by = auth.uid()
   where id = p_plan_id
  returning * into v_plan;

  if coalesce(p_assign_sales_reps, true) then
    insert into perf.employee_commission_plans (employee_id, plan_id, valid_from, created_by)
    select e.id, p_plan_id, p_effective_from, auth.uid()
    from core.employees e
    where e.employment_status in ('active','on_leave')
      and exists (select 1 from authz.user_roles ur join authz.roles ro on ro.id = ur.role_id and ro.is_active
                  where ur.user_id = e.user_id and ro.code = 'sales_rep' and ur.revoked_at is null
                    and (ur.valid_to is null or ur.valid_to > now()))
      and not exists (select 1 from perf.employee_commission_plans ep
                      where ep.employee_id = e.id and ep.cancelled_at is null and ep.valid_from <= p_effective_from
                        and (ep.valid_to is null or ep.valid_to >= p_effective_from))
    on conflict do nothing;
    get diagnostics v_assigned = row_count;
  end if;

  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('commission.plan_activated', 'perf.commission_plan', p_plan_id,
          jsonb_build_object('plan_id', p_plan_id, 'code', v_plan.code, 'effective_from', p_effective_from,
                             'assigned', v_assigned));
  return jsonb_build_object('plan_id', v_plan.id, 'code', v_plan.code, 'status', v_plan.status,
                            'effective_from', v_plan.effective_from, 'assigned', v_assigned, 'replayed', false);
end $$;

-- Active → retired: the plan applies up to and including p_effective_to and never after. Its
-- assignments end that day (those that would start later are cancelled); those employees then
-- earn on the default plan, if that is another plan in force.
create or replace function api.deactivate_commission_plan(p_plan_id uuid, p_effective_to date, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_plan perf.commission_plans%rowtype; v_min date; v_reason text := nullif(btrim(p_reason), '');
        v_ended int := 0; v_cancelled int := 0;
begin
  perform perf.require_plan_manager();
  if p_effective_to is null then
    raise exception 'VALIDATION: an end date is required' using errcode = 'P0001';
  end if;
  perform perf.commission_lock();
  select * into v_plan from perf.commission_plans where id = p_plan_id for update;
  if not found then raise exception 'NOT_FOUND: commission plan %', p_plan_id using errcode = 'P0002'; end if;
  if v_plan.status = 'retired' and v_plan.effective_to = p_effective_to then
    return jsonb_build_object('plan_id', v_plan.id, 'code', v_plan.code, 'status', v_plan.status,
                              'effective_to', v_plan.effective_to, 'replayed', true);
  end if;
  if v_plan.status <> 'active' then
    raise exception 'INVALID_STATE: only an active plan can be deactivated (this one is %)', v_plan.status using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'REASON_REQUIRED: say why the plan ends' using errcode = 'P0001';
  end if;
  if length(v_reason) > 500 then raise exception 'VALIDATION: reason is too long' using errcode = 'P0001'; end if;
  v_min := perf.commission_first_open_month();
  if p_effective_to < v_min - 1 then
    raise exception 'PERIOD_CLOSED: the plan can end on % at the earliest (earlier months are closed)', v_min - 1
      using errcode = 'P0001';
  end if;
  if p_effective_to < v_plan.effective_from - 1 then
    raise exception 'VALIDATION: the end date is before the plan''s start' using errcode = 'P0001';
  end if;
  if p_effective_to > core.business_date() + 366 then
    raise exception 'VALIDATION: the end date is more than a year ahead' using errcode = 'P0001';
  end if;

  update perf.commission_plans
     set status = 'retired', effective_to = p_effective_to, retired_at = now(), retired_by = auth.uid(),
         retire_reason = v_reason
   where id = p_plan_id
  returning * into v_plan;
  update perf.employee_commission_plans set valid_to = p_effective_to
   where plan_id = p_plan_id and cancelled_at is null and valid_from <= p_effective_to
     and (valid_to is null or valid_to > p_effective_to);
  get diagnostics v_ended = row_count;
  update perf.employee_commission_plans set cancelled_at = now(), cancelled_by = auth.uid()
   where plan_id = p_plan_id and cancelled_at is null and valid_from > p_effective_to;
  get diagnostics v_cancelled = row_count;

  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('commission.plan_retired', 'perf.commission_plan', p_plan_id,
          jsonb_build_object('plan_id', p_plan_id, 'code', v_plan.code, 'effective_to', p_effective_to));
  return jsonb_build_object('plan_id', v_plan.id, 'code', v_plan.code, 'status', v_plan.status,
                            'effective_to', v_plan.effective_to, 'assignments_ended', v_ended,
                            'assignments_cancelled', v_cancelled, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Reads
-- ---------------------------------------------------------------------------
create policy commission_plans_select on perf.commission_plans for select to authenticated using (
  (select authz.has_permission('perf.commission_plan.read')) or (select authz.has_permission('perf.commission_plan.manage'))
);
create policy employee_commission_plans_select on perf.employee_commission_plans for select to authenticated using (
  (select authz.has_permission('perf.commission_plan.read')) or (select authz.has_permission('perf.commission_plan.manage'))
);
create policy commission_rules_select_manage on perf.commission_plan_rules for select to authenticated using (
  (select authz.has_permission('perf.commission_plan.manage'))
);

create or replace view api.v_commission_plans with (security_invoker = true) as
select p.id, p.code, p.name, p.basis, p.status, p.effective_from, p.effective_to,
       (p.code = (select s.value #>> '{}' from core.system_settings s where s.key = 'commission.default_plan_code')) as is_default,
       p.activated_at, p.retired_at, p.retire_reason, p.created_at,
       (select count(*) from perf.commission_plan_rules r
         where r.plan_id = p.id and r.voided_at is null
           and (r.effective_from is null or r.effective_from <= core.business_date())
           and (r.effective_to is null or r.effective_to >= core.business_date()))::int as current_rate_count,
       (select count(distinct ep.employee_id) from perf.employee_commission_plans ep
         where ep.plan_id = p.id and ep.cancelled_at is null
           and (ep.valid_to is null or ep.valid_to >= core.business_date()))::int as assigned_count
from perf.commission_plans p;

-- Every rate row (history included). state: void · scheduled (starts after today) · ended · current.
create or replace view api.v_commission_plan_rules with (security_invoker = true) as
select r.id, r.plan_id, p.code as plan_code,
       case when r.variant_id is not null then 'variant' when r.category_id is not null then 'category'
            when r.brand_id is not null then 'brand' else 'default' end as target_type,
       coalesce(r.variant_id, r.category_id, r.brand_id) as target_id,
       coalesce(v.sku, c.code, b.code) as target_code,
       coalesce(v.name_en, c.name_en, b.name) as target_name_en,
       coalesce(pr.name_ar, c.name_ar, b.name) as target_name_ar,
       r.rate_pct, r.priority, r.effective_from, r.effective_to, r.voided_at, r.note, r.created_at,
       case when r.voided_at is not null then 'void'
            when r.effective_from is not null and r.effective_from > core.business_date() then 'scheduled'
            when r.effective_to is not null and r.effective_to < core.business_date() then 'ended'
            else 'current' end as state
from perf.commission_plan_rules r
join perf.commission_plans p on p.id = r.plan_id
left join catalog.brands b on b.id = r.brand_id
left join catalog.categories c on c.id = r.category_id
left join catalog.product_variants v on v.id = r.variant_id
left join catalog.products pr on pr.id = v.product_id;

-- Products (active or draft, variant active) with no rate in the plan on a day (default today):
-- they earn 0 until the owner sets one. Grouped by brand and category in the editor.
create or replace function api.commission_unrated(p_plan_id uuid, p_day date default null)
returns table (variant_id uuid, sku text, variant_name_en text, product_id uuid, product_code text,
               product_name_en text, product_name_ar text, brand_id uuid, brand_code text, brand_name text,
               category_id uuid, category_code text, category_name_en text, category_name_ar text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_day date := coalesce(p_day, core.business_date());
begin
  if not (authz.has_permission('perf.commission_plan.read') or authz.has_permission('perf.commission_plan.manage')) then
    raise exception 'PERMISSION_DENIED: perf.commission_plan.read' using errcode = '42501';
  end if;
  if not exists (select 1 from perf.commission_plans p where p.id = p_plan_id) then
    raise exception 'NOT_FOUND: commission plan %', p_plan_id using errcode = 'P0002';
  end if;
  return query
    select v.id, v.sku, v.name_en, pr.id, pr.code, pr.name_en, pr.name_ar, b.id, b.code, b.name,
           c.id, c.code, c.name_en, c.name_ar
    from catalog.product_variants v
    join catalog.products pr on pr.id = v.product_id
    join catalog.brands b on b.id = pr.brand_id
    join catalog.categories c on c.id = pr.category_id
    cross join lateral perf.commission_rate(p_plan_id, v.id, v_day) rt
    where v.status = 'active' and pr.status in ('active','draft') and rt.o_rule_id is null
    order by b.code, c.code, v.sku
    limit 2000;
end $$;

-- The rep statement of a month: collected cash (incl. VAT) → commissionable amount (excl. VAT)
-- → commission → clawbacks (returns within the window, reversed allocations, bounced payments,
-- net of the re-allocation after a return) → adjustments → net. Lines without a rate are
-- commissionable at 0 % (unrated_base). RLS on the entries and adjustments decides whose rows.
create or replace view api.v_commission_statement_totals with (security_invoker = true) as
select s.period_id, p.period_start, p.period_end, p.status as period_status, s.employee_id,
       emp.employee_no, emp.full_name_en as employee_name_en, emp.full_name_ar as employee_name_ar,
       s.collected_gross::numeric(14,2) as collected_gross,
       (s.collected_gross - s.commissionable)::numeric(14,2) as vat_amount,
       s.commissionable::numeric(14,2) as commissionable,
       s.unrated_base::numeric(14,2) as unrated_base,
       s.commission::numeric(14,2) as commission,
       s.clawbacks::numeric(14,2) as clawbacks,
       s.clawback_base::numeric(14,2) as clawback_base,
       s.adjustments::numeric(14,2) as adjustments,
       (s.commission + s.clawbacks + s.adjustments)::numeric(14,2) as net,
       s.entry_count::int as entry_count
from (
  select l.period_id, l.employee_id,
         coalesce(sum(l.gross) filter (where l.kind = 'collection'), 0) as collected_gross,
         coalesce(sum(l.base) filter (where l.kind = 'collection'), 0) as commissionable,
         coalesce(sum(l.base) filter (where l.kind = 'collection' and l.rate = 0), 0) as unrated_base,
         coalesce(sum(l.amount) filter (where l.kind = 'collection'), 0) as commission,
         coalesce(sum(l.amount) filter (where l.kind in ('reversal','bounce','credit_clawback','credit_reattribution')), 0) as clawbacks,
         coalesce(sum(l.base) filter (where l.kind in ('reversal','bounce','credit_clawback','credit_reattribution')), 0) as clawback_base,
         coalesce(sum(l.amount) filter (where l.kind = 'adjustment'), 0) as adjustments,
         count(*) filter (where l.kind <> 'adjustment') as entry_count
  from (
    select x.period_id, x.employee_id, x.entry_kind as kind, x.gross_amount::numeric as gross,
           x.base_amount::numeric as base, x.rate_pct as rate, x.commission_amount::numeric as amount
    from perf.commission_entries x
    union all
    select x.period_id, x.employee_id, 'adjustment', 0, 0, null, x.amount::numeric from perf.commission_adjustments x
  ) l
  group by l.period_id, l.employee_id
) s
join perf.commission_periods p on p.id = s.period_id
left join lateral perf.commission_employee(s.employee_id) emp on true;

grant select on api.v_commission_plans, api.v_commission_plan_rules, api.v_commission_statement_totals to authenticated;
revoke all on api.v_commission_plans, api.v_commission_plan_rules, api.v_commission_statement_totals from anon;

-- ---------------------------------------------------------------------------
-- 6. Decision D configuration of STD-2026 (idempotent; only while the plan is a draft)
-- ---------------------------------------------------------------------------
insert into perf.commission_plan_rules (plan_id, brand_id, rate_pct, priority, effective_from, note)
select p.id, b.id, v.rate, 50, perf.commission_last_frozen_end() + 1, 'Owner decision D (2026-11-24)'
from perf.commission_plans p
cross join (values ('BIONER', 5.00), ('DERBY', 1.50), ('RDT', 1.50)) as v(brand, rate)
join catalog.brands b on b.code = v.brand
where p.code = 'STD-2026' and p.status = 'draft'
  and not exists (select 1 from perf.commission_plan_rules r where r.plan_id = p.id and r.brand_id = b.id and r.voided_at is null);
-- Collected basis, VAT excluded and the 90-day clawback are already the engine's rules
-- (basis 'collected', base = line net ÷ line total of the money, setting commission.clawback_days
-- = 90 seeded by 20261103000800): nothing to change.

-- ---------------------------------------------------------------------------
-- 7. Privileges (explicit; never "all functions in schema")
-- ---------------------------------------------------------------------------
revoke execute on function
  perf.commission_last_frozen_end(),
  perf.guard_commission_rule(),
  perf.guard_commission_plan(),
  perf.require_plan_manager(),
  perf.commission_plan_for(uuid, date),
  perf.commission_rate(uuid, uuid, date),
  perf.commission_replay_invoice(uuid, uuid, date, date, date, date, int, uuid)
from public, anon, authenticated;
revoke all on function service.commission_calculate(date) from public, anon, authenticated;
grant execute on function service.commission_calculate(date) to service_role;

revoke execute on function
  api.create_commission_plan(text, text),
  api.set_commission_rate(uuid, text, uuid, numeric, date, text, text),
  api.activate_commission_plan(uuid, date, boolean),
  api.deactivate_commission_plan(uuid, date, text),
  api.commission_unrated(uuid, date)
from public, anon;
grant execute on function
  api.create_commission_plan(text, text),
  api.set_commission_rate(uuid, text, uuid, numeric, date, text, text),
  api.activate_commission_plan(uuid, date, boolean),
  api.deactivate_commission_plan(uuid, date, text),
  api.commission_unrated(uuid, date)
to authenticated;
