-- Honest OS migration: fixes for the 2026-10-29 independent audit (findings #1–#5,
-- #8, #11, #13, #15). Function redefinitions for #3, #6, #7, #10, #12, #14 are in
-- 20261029001050_audit_fix_functions.sql. Regression tests: tests/database/17_*.

-- ---------------------------------------------------------------------------
-- #1 Stock in quarantine / transit / inactive warehouses is never sellable.
-- Enforced on the tables, so every present and future path is covered.
-- ---------------------------------------------------------------------------
create or replace function inventory.assert_sellable_warehouse() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_kind text; v_active boolean;
begin
  -- Separate IFs: PL/pgSQL does not short-circuit, and reservations have no movement_type.
  if tg_table_name = 'movements' then
    if new.movement_type <> 'sale_issue' then return new; end if;
  end if;
  select kind, is_active into v_kind, v_active from inventory.warehouses where id = new.warehouse_id;
  if v_kind in ('quarantine', 'transit') or not coalesce(v_active, false) then
    raise exception 'WAREHOUSE_NOT_SELLABLE: % warehouse stock cannot be reserved or sold',
      coalesce(v_kind, 'unknown') using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger trg_reservations_sellable before insert on inventory.reservations
  for each row execute function inventory.assert_sellable_warehouse();
create trigger trg_movements_sellable before insert on inventory.movements
  for each row execute function inventory.assert_sellable_warehouse();

-- ---------------------------------------------------------------------------
-- #2 Orders of archived or blocked customers cannot advance.
-- Cancelling / rejecting stays possible.
-- ---------------------------------------------------------------------------
create or replace function sales.assert_customer_open() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_stage text; v_archived timestamptz;
begin
  if new.status is not distinct from old.status
     or new.status not in ('submitted','pending_approval','approved','reserved','partially_fulfilled','fulfilled') then
    return new;
  end if;
  select lifecycle_stage, archived_at into v_stage, v_archived from crm.customers where id = new.customer_id;
  if v_stage = 'blocked' or v_archived is not null then
    raise exception 'CUSTOMER_BLOCKED: customer is % — the order cannot move to %',
      case when v_archived is not null then 'archived' else 'blocked' end, new.status using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger trg_orders_customer_open before update of status on sales.orders
  for each row execute function sales.assert_customer_open();

-- ---------------------------------------------------------------------------
-- #3 Helper: quantity a user adjusted today without approval (Cairo calendar day).
-- ---------------------------------------------------------------------------
create or replace function inventory.unapproved_adjusted_today(p_user uuid, p_warehouse_id uuid, p_variant_id uuid)
returns int language sql stable security definer set search_path = '' as $$
  select coalesce(sum(abs(m.quantity)), 0)::int
  from inventory.movements m
  where m.created_by = p_user and m.warehouse_id = p_warehouse_id and m.variant_id = p_variant_id
    and m.movement_type in ('adjustment_in', 'adjustment_out') and m.approval_request_id is null
    and m.created_at >= (date_trunc('day', now() at time zone 'Africa/Cairo') at time zone 'Africa/Cairo')
$$;

-- ---------------------------------------------------------------------------
-- #4 Audit log: clients see metadata only (the columns of api.v_audit_log),
-- never old/new row images, which would bypass every table's RLS.
-- ---------------------------------------------------------------------------
revoke select on audit.audit_log from authenticated;
grant select (id, occurred_at, actor_user_id, action, table_schema, table_name, record_id, changed_fields, request_id)
  on audit.audit_log to authenticated;

-- ---------------------------------------------------------------------------
-- #11 Direct adjustments skip validation and approval routing; only
-- api.request_inventory_adjustment (which validates, then calls it as owner) remains.
-- ---------------------------------------------------------------------------
revoke execute on function api.post_inventory_adjustment(uuid, uuid, uuid, int, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- #13 Scope-aware admin read policies (team-scoped admins see their team only).
-- ---------------------------------------------------------------------------
create or replace function authz.employee_of_user(p_user uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select employee_id from core.user_profiles where user_id = p_user
$$;

drop policy profiles_self on core.user_profiles;
create policy profiles_self on core.user_profiles for select to authenticated using (
  user_id = auth.uid()
  or (select authz.has_global('admin.user.read'))
  or employee_id = any((select authz.employee_ids('admin.user.read'))::uuid[])
);

drop policy user_roles_select on authz.user_roles;
create policy user_roles_select on authz.user_roles for select to authenticated using (
  user_id = auth.uid()
  or (select authz.has_global('admin.role.read'))
  or authz.employee_of_user(user_id) = any((select authz.employee_ids('admin.role.read'))::uuid[])
);

drop policy audit_log_select on audit.audit_log;
create policy audit_log_select on audit.audit_log for select to authenticated
  using ((select authz.has_global('audit.log.read')));
drop policy security_events_select on audit.security_events;
create policy security_events_select on audit.security_events for select to authenticated
  using ((select authz.has_global('audit.security.read')));

-- ---------------------------------------------------------------------------
-- #15 (DB side) A role cannot be granted twice with the same bindings, so a
-- retried grant can never create a duplicate assignment.
-- ---------------------------------------------------------------------------
create unique index uq_user_roles_active on authz.user_roles
  (user_id, role_id, scope_territory_id, scope_warehouse_id, scope_department_id) nulls not distinct
  where revoked_at is null;

-- ---------------------------------------------------------------------------
-- #5 #8 Privilege sweep: SECURITY DEFINER functions outside api/service are
-- internal. Revoke client execute on every one that no RLS policy or view
-- needs (policies and security_invoker views call helpers as the client).
-- Examples closed: sales.resolve_list_price (leaked customer price lists),
-- authz.log_security_event (forged security events), authz.can_grant.
-- Test 17 keeps this true for future migrations.
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.prosecdef
      and n.nspname in ('core','authz','catalog','inventory','crm','field','work','sales',
                        'finance','perf','wf','audit','notify','integration')
      and not exists (select 1 from pg_policies pol
                      where coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '') ~ ('\m' || p.proname || '\M'))
      and not exists (select 1 from pg_views v
                      where v.schemaname in ('api','core','authz','catalog','inventory','crm','field','work','sales',
                                             'finance','perf','wf','audit','notify','integration')
                        and v.definition ~ ('\m' || p.proname || '\M'))
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
