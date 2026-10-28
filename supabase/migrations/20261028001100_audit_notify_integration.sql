-- Honest OS migration: audit, notifications, integration
-- Origin: docs/database/draft/10_schema_draft.sql (Phase 1, validated). See docs/DATABASE.md.

-- ---------------------------------------------------------------------------
-- AUDIT, NOTIFICATIONS, INTEGRATION
-- ---------------------------------------------------------------------------
create table audit.audit_log (
  id            bigint generated always as identity primary key,
  occurred_at   timestamptz not null default now(),
  actor_user_id uuid,
  action        text not null check (action in ('INSERT','UPDATE','DELETE')),
  table_schema  text not null,
  table_name    text not null,
  record_id     text,
  old_data      jsonb,
  new_data      jsonb,
  changed_fields text[],
  request_id    text            -- correlation id set by the app: set_config('app.request_id', ...)
);
create index on audit.audit_log (table_schema, table_name, record_id);
create index on audit.audit_log (actor_user_id, occurred_at desc);
create trigger trg_audit_append_only before update or delete on audit.audit_log
  for each row execute function core.forbid_mutation();

create table audit.security_events (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  user_id     uuid,
  event_type  text not null,     -- 'login','login_failed','permission_denied','role_granted','role_revoked','user_suspended','export','owner_change'
  severity    text not null default 'info' check (severity in ('info','warning','critical')),
  details     jsonb not null default '{}'
);
create trigger trg_security_append_only before update or delete on audit.security_events
  for each row execute function core.forbid_mutation();

create or replace function audit.log_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_old jsonb; v_new jsonb; v_changed text[];
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  if tg_op = 'UPDATE' then
    select array_agg(k) into v_changed
    from jsonb_object_keys(v_new) k where v_new -> k is distinct from v_old -> k;
    if v_changed is null then return null; end if;   -- no-op update
  end if;
  insert into audit.audit_log (actor_user_id, action, table_schema, table_name, record_id,
                               old_data, new_data, changed_fields, request_id)
  values (auth.uid(), tg_op, tg_table_schema, tg_table_name,
          coalesce(v_new ->> 'id', v_old ->> 'id'), v_old, v_new, v_changed,
          nullif(current_setting('app.request_id', true), ''));
  return null;
end $$;

-- Attach audit to every table whose history matters.
do $$
declare t text;
begin
  foreach t in array array[
    'core.employees','core.user_profiles','core.system_settings','core.territories',
    'authz.roles','authz.role_permissions','authz.user_roles','authz.user_permission_overrides',
    'catalog.products','catalog.product_variants','catalog.product_costs','catalog.price_lists','catalog.price_list_items',
    'crm.customers','crm.customer_assignments',
    'sales.orders','sales.order_items','sales.discount_rules',
    'finance.invoices','finance.payments',
    'perf.kpi_definitions','perf.kpi_targets','perf.commission_plans','perf.commission_plan_rules',
    'perf.commission_periods','perf.commission_adjustments',
    'wf.workflow_definitions','wf.workflow_rules','wf.workflow_stages','wf.approval_requests',
    'inventory.warehouses','inventory.transfers']
  loop
    execute format('create trigger trg_audit after insert or update or delete on %s
                    for each row execute function audit.log_change()', t);
  end loop;
end $$;

create table notify.notifications (
  id                uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references auth.users(id),
  type              text not null,              -- 'approval.requested','order.approved','task.due',...
  title             text not null,
  body              text,
  link              text,
  data              jsonb not null default '{}',
  read_at           timestamptz,
  created_at        timestamptz not null default now()
);
create index on notify.notifications (recipient_user_id, created_at desc) where read_at is null;

create table notify.channel_preferences (
  user_id   uuid not null references auth.users(id),
  type      text not null,
  channel   text not null check (channel in ('in_app','push','email','whatsapp')),
  enabled   boolean not null default true,
  primary key (user_id, type, channel)
);

-- Transactional outbox (the "integration_events" entity) — written in the same
-- transaction as the business change; a dispatcher delivers it (ADR-016).
create table integration.outbox (
  id              uuid primary key default gen_random_uuid(),
  event_type      text not null,                -- 'order.submitted','invoice.overdue','stock.below_threshold'
  aggregate_type  text not null,
  aggregate_id    uuid not null,
  payload         jsonb not null,
  status          text not null default 'pending' check (status in ('pending','in_flight','delivered','failed','dead')),
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz
);
create index on integration.outbox (status, next_attempt_at) where status in ('pending','failed');

create table integration.inbound_webhooks (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null,              -- 'paymob','shopify','whatsapp'
  external_event_id text not null,
  signature_valid   boolean not null,
  payload           jsonb not null,
  status            text not null default 'received' check (status in ('received','processed','ignored','failed')),
  error             text,
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  unique (provider, external_event_id)          -- idempotent receipt
);

create table integration.external_refs (
  entity_type text not null,                    -- 'customer','variant','order'
  entity_id   uuid not null,
  provider    text not null,                    -- 'shopify'
  external_id text not null,
  synced_at   timestamptz not null default now(),
  primary key (provider, entity_type, external_id),
  unique (provider, entity_type, entity_id)
);
