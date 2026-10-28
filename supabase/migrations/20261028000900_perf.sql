-- Honest OS migration: kpi and commission engines
-- Origin: docs/database/draft/10_schema_draft.sql (Phase 1, validated). See docs/DATABASE.md.

-- ---------------------------------------------------------------------------
-- PERFORMANCE: KPI engine + commissions (formulas are code-registered metrics — ADR-015)
-- ---------------------------------------------------------------------------
create table perf.kpi_definitions (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,         -- 'VISITS_COMPLETED','NEW_ACCOUNTS','COLLECTION_RATE'
  name_en        text not null,
  name_ar        text,
  definition     text not null,                -- plain-language definition shown in the UI
  formula        text not null,                -- documented formula (human readable)
  metric_key     text not null,                -- registered SQL metric function (whitelist)
  data_source    text not null,                -- tables the metric reads
  indicator_type text not null check (indicator_type in ('leading','lagging')),
  period_type    text not null check (period_type in ('week','month','quarter','year')),
  unit           text not null check (unit in ('count','pct','egp','ratio')),
  higher_is_better boolean not null default true,
  status         text not null default 'active' check (status in ('draft','active','retired')),
  version        int not null default 1,
  effective_from date not null default current_date
);

create table perf.kpi_targets (
  id           uuid primary key default gen_random_uuid(),
  kpi_id       uuid not null references perf.kpi_definitions(id),
  role_id      uuid references authz.roles(id),
  employee_id  uuid references core.employees(id),
  territory_id uuid references core.territories(id),
  target_value numeric(14,2) not null,
  weight_pct   numeric(5,2) not null default 0 check (weight_pct between 0 and 100),
  period_start date not null,
  period_end   date not null,
  set_by       uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  check (num_nonnulls(role_id, employee_id, territory_id) = 1),
  check (period_end >= period_start)
);

create table perf.kpi_results (
  id             uuid primary key default gen_random_uuid(),
  kpi_id         uuid not null references perf.kpi_definitions(id),
  employee_id    uuid references core.employees(id),
  territory_id   uuid references core.territories(id),
  period_start   date not null,
  period_end     date not null,
  actual_value   numeric(14,2) not null,
  target_value   numeric(14,2),
  achievement_pct numeric(7,2),
  kpi_version    int not null,
  computed_at    timestamptz not null default now(),
  is_final       boolean not null default false,   -- frozen after period close
  source_snapshot jsonb not null default '{}',     -- counts/ids used → traceability
  unique nulls not distinct (kpi_id, employee_id, territory_id, period_start, kpi_version)
);

create table perf.commission_plans (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null unique,
  name                 text not null,
  basis                text not null default 'collected' check (basis in ('collected','invoiced')),
  min_achievement_pct  numeric(5,2),                -- eligibility threshold, optional
  effective_from       date not null,
  effective_to         date,
  status               text not null default 'draft' check (status in ('draft','active','retired'))
);

create table perf.commission_plan_rules (
  id          uuid primary key default gen_random_uuid(),
  plan_id     uuid not null references perf.commission_plans(id) on delete cascade,
  brand_id    uuid references catalog.brands(id),
  category_id uuid references catalog.categories(id),
  variant_id  uuid references catalog.product_variants(id),
  rate_pct    numeric(5,2) not null check (rate_pct between 0 and 100),   -- seed: IMPLANT 5.00, BUR/INSTRUMENT 1.50
  priority    int not null default 100                                    -- most specific rule wins
);

create table perf.employee_commission_plans (
  employee_id uuid not null references core.employees(id),
  plan_id     uuid not null references perf.commission_plans(id),
  valid_from  date not null,
  valid_to    date,
  primary key (employee_id, plan_id, valid_from)
);

create table perf.commission_periods (
  id           uuid primary key default gen_random_uuid(),
  period_start date not null,
  period_end   date not null,
  status       text not null default 'open' check (status in ('open','calculated','approved','paid','locked')),
  calculated_at timestamptz,
  approved_by  uuid references auth.users(id),
  approved_at  timestamptz,
  unique (period_start, period_end)
);

create table perf.commission_entries (
  id               uuid primary key default gen_random_uuid(),
  period_id        uuid not null references perf.commission_periods(id),
  employee_id      uuid not null references core.employees(id),
  plan_id          uuid not null references perf.commission_plans(id),
  rule_id          uuid references perf.commission_plan_rules(id),
  source_type      text not null check (source_type in ('payment_allocation','credit_note','allocation_reversal')),
  source_id        uuid not null,
  invoice_item_id  uuid references finance.invoice_items(id),
  base_amount      core.money not null,            -- net of tax, signed
  rate_pct         numeric(5,2) not null,
  commission_amount core.money not null,
  calc_run_id      uuid not null,
  created_at       timestamptz not null default now(),
  unique (source_type, source_id, invoice_item_id, employee_id)   -- no double counting
);

create table perf.commission_adjustments (
  id                  uuid primary key default gen_random_uuid(),
  period_id           uuid not null references perf.commission_periods(id),
  employee_id         uuid not null references core.employees(id),
  amount              core.money not null check (amount <> 0),
  kind                text not null check (kind in ('bonus','clawback','correction')),
  reason              text not null,
  approval_request_id uuid,
  created_by          uuid references auth.users(id),
  created_at          timestamptz not null default now()
);
