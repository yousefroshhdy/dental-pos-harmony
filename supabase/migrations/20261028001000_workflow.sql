-- Honest OS migration: approval workflow engine
-- Origin: docs/database/draft/10_schema_draft.sql (Phase 1, validated). See docs/DATABASE.md.

-- ---------------------------------------------------------------------------
-- WORKFLOW: configurable approvals
-- ---------------------------------------------------------------------------
create table wf.workflow_definitions (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,   -- 'sales.order.discount','inventory.adjustment','crm.customer.reassign'
  name        text not null,
  entity_type text not null,
  is_active   boolean not null default true,
  version     int not null default 1
);

-- First matching rule (by priority) decides the stages. Condition is a small,
-- validated JSON predicate evaluated server-side — never SQL text.
create table wf.workflow_rules (
  id            uuid primary key default gen_random_uuid(),
  definition_id uuid not null references wf.workflow_definitions(id) on delete cascade,
  priority      int not null,
  condition     jsonb not null default '{}',   -- {"all":[{"field":"discount_pct","op":">","value":10}]}
  auto_approve  boolean not null default false,
  unique (definition_id, priority)
);

create table wf.workflow_stages (
  id                 uuid primary key default gen_random_uuid(),
  rule_id            uuid not null references wf.workflow_rules(id) on delete cascade,
  stage_no           int not null,
  approver_type      text not null check (approver_type in ('permission','role','requester_manager','user')),
  approver_permission text references authz.permissions(code),
  approver_role_id   uuid references authz.roles(id),
  approver_user_id   uuid references auth.users(id),
  required_approvals int not null default 1 check (required_approvals >= 1),
  escalate_after     interval,
  unique (rule_id, stage_no)
);

create table wf.approval_requests (
  id              uuid primary key default gen_random_uuid(),
  definition_id   uuid not null references wf.workflow_definitions(id),
  rule_id         uuid references wf.workflow_rules(id),
  entity_type     text not null,
  entity_id       uuid not null,
  requested_by    uuid not null references auth.users(id),
  payload         jsonb not null,               -- frozen snapshot of what is being approved
  status          text not null default 'pending' check (status in ('pending','approved','rejected','cancelled','expired')),
  current_stage   int not null default 1,
  created_at      timestamptz not null default now(),
  decided_at      timestamptz
);
create unique index uq_one_pending_request on wf.approval_requests (definition_id, entity_id) where status = 'pending';

create table wf.approval_steps (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid not null references wf.approval_requests(id),
  stage_no       int not null,
  approver_id    uuid not null references auth.users(id),
  on_behalf_of   uuid references auth.users(id),   -- delegation
  decision       text not null check (decision in ('approved','rejected')),
  comment        text,
  decided_at     timestamptz not null default now(),
  unique (request_id, stage_no, approver_id)
);
create trigger trg_approval_steps_append_only before update or delete on wf.approval_steps
  for each row execute function core.forbid_mutation();

create table wf.delegations (
  id            uuid primary key default gen_random_uuid(),
  from_user_id  uuid not null references auth.users(id),
  to_user_id    uuid not null references auth.users(id),
  definition_id uuid references wf.workflow_definitions(id),   -- null = all workflows
  valid_from    timestamptz not null,
  valid_to      timestamptz not null,
  created_at    timestamptz not null default now(),
  check (from_user_id <> to_user_id and valid_to > valid_from)
);

alter table inventory.movements
  add constraint fk_mov_approval foreign key (approval_request_id) references wf.approval_requests(id);
