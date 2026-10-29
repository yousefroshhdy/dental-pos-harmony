-- Supabase performance advisor (auth_rls_initplan): five policies called auth.uid()
-- once per row. Wrapping it as (select auth.uid()) makes Postgres evaluate it once
-- per statement (an InitPlan). Same predicates, so no behaviour change.
-- ALTER POLICY (not drop/create) keeps each policy in force throughout.

alter policy profiles_self on core.user_profiles using (
  user_id = (select auth.uid())
  or (select authz.has_global('admin.user.read'))
  or employee_id = any((select authz.employee_ids('admin.user.read'))::uuid[])
);

alter policy user_roles_select on authz.user_roles using (
  user_id = (select auth.uid())
  or (select authz.has_global('admin.role.read'))
  or authz.employee_of_user(user_id) = any((select authz.employee_ids('admin.role.read'))::uuid[])
);

alter policy employees_select on core.employees using (
  user_id = (select auth.uid())
  or (select authz.has_global('core.employee.read'))
  or id = any((select authz.employee_ids('core.employee.read'))::uuid[])
);

alter policy notifications_own on notify.notifications
  using (recipient_user_id = (select auth.uid()));

alter policy notifications_mark_read on notify.notifications
  using (recipient_user_id = (select auth.uid()))
  with check (recipient_user_id = (select auth.uid()));
