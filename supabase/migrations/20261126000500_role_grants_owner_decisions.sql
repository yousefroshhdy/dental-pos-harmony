-- Honest OS migration: Phase P, role grants decided by the owner (answers given 2026-11-28).
--
-- docs/DECISIONS.md Part C (2026-11-28). The owner answered four role questions:
--
--   1. Commission adjustments: "keep as is". Only owners request and decide an adjustment, and the
--      requester never decides their own request, so a second owner approves it (D-08). No grant
--      changes here; suite 64 pins it (no role holds perf.commission.adjust or
--      wf.decide.commission_adjust; the requesting owner gets SELF_APPROVAL).
--   2. "The finance officer sees the company dashboard." /dashboard needs perf.kpi.read; finance held
--      exec.page.overview but not perf.kpi.read. Granted at company-wide scope ('all'), which is what
--      api.kpi_summary / kpi_team / kpi_breakdown / kpi_overdue_customers read for the company layout.
--      Nothing else is widened (no stock permission, so the stock-alert tile stays hidden for finance;
--      no target or plan permission).
--   3. "The collection officer works the field like a rep, for visits": start and end the day (location
--      tracking during the shift, the same notice and privacy rules), see their own visits, check in and
--      out at clinics. The collection officer gets every field.* permission the sales rep holds, at the
--      same own scope: field.shift.start (start/end the day, tracking points, device status, tracking
--      notice), field.visit.read (own visits and own day), field.visit.plan (plan own visits),
--      field.visit_exception.request (ask for an exception when a check-in is out of range) and
--      field.visit.export (the visit export follows field.visit.read, 20261104001100; MFA-gated).
--      field.visit.create (check-in/out) was already held. No order, lead or commission permission.
--   4. "The sales director sees tracking for the whole company": field.tracking.read and its export
--      field.tracking.export go from team to all. Every tracking read already honours 'all' through
--      authz.has_global('field.tracking.read') (api.tracking_day, api.tracking_team_day,
--      api.v_tracking_health, api.v_team_last_location and the RLS on shifts, points and device status).
--
-- Additive only: inserts with on conflict, and two scope widenings as updates of existing grant rows
-- (no permission is removed, no row deleted). Custom roles are untouched. The MFA-gated permission set
-- (suites 39 and 48) does not change. Tests: supabase/tests/database/64_role_grants_owner_decisions.test.sql.

-- ---------------------------------------------------------------------------
-- 2. Finance officer: company dashboard
-- 3. Collection officer: the rep's field permissions, own scope
-- ---------------------------------------------------------------------------
insert into authz.role_permissions (role_id, permission_code, scope, limit_value)
select r.id, v.perm, v.scope, null
from (values
  ('finance_officer',    'perf.kpi.read',                 'all'),
  ('collection_officer', 'field.shift.start',             'own'),
  ('collection_officer', 'field.visit.read',              'own'),
  ('collection_officer', 'field.visit.plan',              'own'),
  ('collection_officer', 'field.visit_exception.request', 'own'),
  ('collection_officer', 'field.visit.export',            'own')
) v(role, perm, scope)
join authz.roles r on r.code = v.role
on conflict (role_id, permission_code) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Sales director: tracking for the whole company (team → all)
-- ---------------------------------------------------------------------------
update authz.role_permissions rp
   set scope = 'all'
  from authz.roles r
 where r.id = rp.role_id and r.code = 'sales_director'
   and rp.permission_code in ('field.tracking.read', 'field.tracking.export')
   and rp.scope = 'team';
