-- Honest OS migration: one dedicated, MFA-gated export permission per CSV export kind.
--
-- Owner decision (docs/DECISIONS.md, 2026-10-31): every export kind gets its own
-- <module>.<resource>.export permission, gated by the MFA step-up. Before this, only customers
-- (crm.customer.export) and orders / order lines (sales.order.export) had one; the other kinds
-- reused their list's read permission, so they could not be MFA-gated without gating every page
-- read (20261104000710, A-L4).
--
-- All additive:
--   1. Six new permissions, is_sensitive and requires_mfa, with the allowed scopes of the read
--      permission they pair with:
--        finance.invoice.export   (invoices)   pairs with finance.invoice.read
--        finance.payment.export   (payments)   pairs with finance.payment.read
--        finance.aging.export     (aging)      pairs with finance.page.aging or finance.ledger.read
--        field.visit.export       (visits)     pairs with field.visit.read
--        inventory.stock.export   (stock)      pairs with inventory.stock.read
--        field.tracking.export    (tracking)   pairs with field.tracking.read
--   2. Behaviour is kept: every role that holds the paired read permission today gets the export
--      permission at the same scope (derived from authz.role_permissions, so custom roles are
--      covered too). For aging, a role holding both alternatives takes the finance.page.aging
--      scope. Active per-user GRANT overrides of a paired read permission are copied the same way
--      (same scope, territory, expiry and grantor; no limit). Deny overrides are not copied: the
--      read permission stays in each rule, so a deny on it still blocks the export.
--   3. audit.export_kinds() is redefined: each kind requires its read permission AND its export
--      permission (the read permission first, so a user without either is told about the read
--      permission). audit.require_export runs authz.require on each permission of the held rule,
--      so the step-up applies to every kind once security.mfa_enforced is on. The filter keys are
--      unchanged. tests/unit/reports-export-log.test.ts reads the LATEST migration that carries
--      the export-kinds markers and compares it with src/modules/reports/kinds.ts.
--
-- Nothing changes while security.mfa_enforced is off (the shipped default), apart from the new
-- permission rows and grants. Suites 39 and 48 pin the gated set; suite 54 covers this file.

-- ---------------------------------------------------------------------------
-- 1. Permissions (reference-data pattern; the scopes follow the paired read permission)
-- ---------------------------------------------------------------------------
insert into authz.permissions (code, module, description, allowed_scopes, supports_limit, is_sensitive, requires_mfa)
select v.code, split_part(v.code, '.', 1), v.descr,
       coalesce((select p.allowed_scopes from authz.permissions p where p.code = v.paired),
                '{own,team,territory,department,warehouse,all}'),
       false, true, true
from (values
  ('finance.invoice.export', 'finance.invoice.read', 'Export invoice lists to CSV'),
  ('finance.payment.export', 'finance.payment.read', 'Export payment lists to CSV'),
  ('finance.aging.export',   'finance.page.aging',   'Export the receivables aging to CSV'),
  ('field.visit.export',     'field.visit.read',     'Export visit lists to CSV'),
  ('inventory.stock.export', 'inventory.stock.read', 'Export stock levels to CSV'),
  ('field.tracking.export',  'field.tracking.read',  'Export the team day summary (work-hours tracking) to CSV')
) v(code, paired, descr)
on conflict (code) do nothing;

-- Restated in case a row already existed without the flags (idempotent).
update authz.permissions set is_sensitive = true, requires_mfa = true
where code in ('finance.invoice.export', 'finance.payment.export', 'finance.aging.export',
               'field.visit.export', 'inventory.stock.export', 'field.tracking.export')
  and not (is_sensitive and requires_mfa);

-- ---------------------------------------------------------------------------
-- 2. Keep current behaviour: the roles and users who can export a kind today keep it
-- ---------------------------------------------------------------------------
-- The pairs (export permission, read permission it requires today, preference for aging).
create or replace view pg_temp.export_pairs as
select * from (values
  ('finance.invoice.export', 'finance.invoice.read', 1),
  ('finance.payment.export', 'finance.payment.read', 1),
  ('finance.aging.export',   'finance.page.aging',   1),
  ('finance.aging.export',   'finance.ledger.read',  2),
  ('field.visit.export',     'field.visit.read',     1),
  ('inventory.stock.export', 'inventory.stock.read', 1),
  ('field.tracking.export',  'field.tracking.read',  1)
) v(export_code, read_code, pref);

-- Role grants: same roles, same scope as the paired read permission (the owner role holds every
-- permission implicitly and has no rows).
insert into authz.role_permissions (role_id, permission_code, scope, limit_value)
select distinct on (rp.role_id, x.export_code) rp.role_id, x.export_code, rp.scope, null::numeric
from authz.role_permissions rp
join pg_temp.export_pairs x on x.read_code = rp.permission_code
order by rp.role_id, x.export_code, x.pref
on conflict (role_id, permission_code) do nothing;

-- Per-user grant overrides that are still in force: copied once per user and export permission.
insert into authz.user_permission_overrides
  (user_id, permission_code, effect, scope, scope_territory_id, limit_value, reason, expires_at, granted_by)
select distinct on (o.user_id, x.export_code)
       o.user_id, x.export_code, 'grant', o.scope, o.scope_territory_id, null::numeric,
       left('Copied from ' || o.permission_code || ' (per-kind export permissions, 20261104001100): ' || o.reason, 1000),
       o.expires_at, o.granted_by
from authz.user_permission_overrides o
join pg_temp.export_pairs x on x.read_code = o.permission_code
where o.effect = 'grant' and (o.expires_at is null or o.expires_at > now())
  and not exists (select 1 from authz.user_permission_overrides e
                  where e.user_id = o.user_id and e.permission_code = x.export_code)
order by o.user_id, x.export_code, x.pref, o.created_at desc;

drop view pg_temp.export_pairs;

-- ---------------------------------------------------------------------------
-- 3. The export whitelist. From 20261104000710_audit4_export_log.sql (latest). Change: each kind
--    requires its own export permission next to its read permission. "perms": alternatives
--    (outer list ORed, inner list ANDed), mirroring EXPORT_PERMISSIONS in
--    src/modules/reports/kinds.ts; "filters": the keys of FILTER_SCHEMAS in
--    src/modules/reports/schemas.ts (unchanged). Keep the markers: the unit test reads them.
-- ---------------------------------------------------------------------------
create or replace function audit.export_kinds() returns jsonb
language sql immutable set search_path = '' as $$
  select
-- export-kinds:begin
$json${
  "orders":      { "perms": [["sales.order.read", "sales.order.export"]], "filters": ["status", "from", "to"] },
  "order_lines": { "perms": [["sales.order.read", "sales.order.export"]], "filters": ["status", "from", "to"] },
  "invoices":    { "perms": [["finance.invoice.read", "finance.invoice.export"]], "filters": ["status", "bucket", "customer", "from", "to"] },
  "payments":    { "perms": [["finance.payment.read", "finance.payment.export"]], "filters": ["status", "customer", "from", "to"] },
  "aging":       { "perms": [["finance.page.aging", "finance.aging.export"], ["finance.ledger.read", "finance.aging.export"]], "filters": [] },
  "visits":      { "perms": [["field.visit.read", "field.visit.export"]], "filters": ["status", "who", "from", "to"] },
  "customers":   { "perms": [["crm.customer.read", "crm.customer.export"]], "filters": ["q", "stage", "territory", "specialty"] },
  "stock":       { "perms": [["inventory.stock.read", "inventory.stock.export"]], "filters": ["warehouse", "brand", "product"] },
  "tracking":    { "perms": [["field.tracking.read", "field.tracking.export"]], "filters": ["date"] }
}$json$
-- export-kinds:end
  ::jsonb
$$;

-- Privileges (unchanged; restated because CREATE OR REPLACE keeps them and PostgreSQL grants
-- PUBLIC execute on new functions by default).
revoke execute on function audit.export_kinds() from public, anon, authenticated;
