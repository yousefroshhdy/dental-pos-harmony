-- Honest OS migration: Phase P, the owner sets an unknown lot cost once (owner decision 2026-11-24).
--
-- Opening stock imported with cost_unknown (20261125000110) brings units in with a NULL purchase cost
-- (never 0). The owner may record that cost later, ONCE per lot, with a reason:
--
--   inventory.lot_costs        one row per lot: unit_cost (> 0), reason, idempotency key, who and when.
--                              Append-only (core.forbid_mutation) and audited (audit.log_change), so a
--                              known cost is never overwritten; RLS: catalog.cost.read.
--   inventory.lot_cost_status  per lot: 'unknown' (a receipt brought units in without a cost and no cost
--                              was set), 'set' (inventory.lot_costs), 'known' (every receipt had a cost).
--   api.set_lot_cost           owner only: authz.require('inventory.lot.set_cost') (requires_mfa, granted
--                              to no role; the owner holds every permission) AND authz.is_owner().
--                              Refuses a lot whose cost is known or already set (COST_ALREADY_SET); a
--                              retry with the same key and value replays. Outbox inventory.lot_cost_set
--                              (without the amount).
--   api.v_lot_costs            (security_invoker) the cost status of each received lot, for cost readers
--                              with company-wide stock access (owner, inventory manager); reps never.
--   api.v_legacy_import_quality  restated: an "item without cost" also leaves the list once every one of
--                              its unknown-cost lots has a cost.
--
-- Not back-filled (decision): past movements and receipt lines keep their NULL cost; units already sold
-- stay "cost unknown". inventory.lots itself is unchanged (no audit trigger there; the cost lives in its
-- own audited table). Additive only. Tests: supabase/tests/database/63_set_lot_cost.test.sql; the MFA
-- set pinned by suites 39 and 48 gains inventory.lot.set_cost.

-- ---------------------------------------------------------------------------
-- 1. Permission (sensitive, MFA-gated, company-wide, no role grants)
-- ---------------------------------------------------------------------------
insert into authz.permissions (code, module, description, allowed_scopes, supports_limit, is_sensitive, requires_mfa)
values ('inventory.lot.set_cost', 'inventory', 'Set the purchase cost of a stock lot whose cost is unknown (once)', '{all}', false, true, true)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Table
-- ---------------------------------------------------------------------------
create table inventory.lot_costs (
  id              uuid not null default gen_random_uuid() unique,   -- for the audit log (record_id)
  lot_id          uuid primary key references inventory.lots(id),
  unit_cost       core.money not null check (unit_cost > 0),
  reason          text not null check (length(reason) between 3 and 500),
  idempotency_key uuid not null unique,
  set_by          uuid not null references auth.users(id),
  set_at          timestamptz not null default now()
);
create index on inventory.lot_costs (set_by);
comment on table inventory.lot_costs is
  'The owner''s purchase cost for a lot received with an unknown cost; set once (api.set_lot_cost), never edited. Past movements are not back-filled.';

create trigger trg_lot_costs_append_only before update or delete on inventory.lot_costs
  for each row execute function core.forbid_mutation();
create trigger trg_audit after insert or update or delete on inventory.lot_costs
  for each row execute function audit.log_change();

alter table inventory.lot_costs enable row level security;
create policy lot_costs_select on inventory.lot_costs for select to authenticated
  using ((select authz.has_permission('catalog.cost.read')));
revoke all on inventory.lot_costs from public, anon, authenticated;
grant select on inventory.lot_costs to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Command
-- ---------------------------------------------------------------------------
-- p_idempotency_key is page-generated: a retried request with the same key and value replays.
create or replace function api.set_lot_cost(p_lot_id uuid, p_unit_cost numeric, p_reason text, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_lot inventory.lots%rowtype;
  v_sku text;
  v_set inventory.lot_costs%rowtype;
begin
  -- Permission first (a non-holder never learns about MFA), then MFA (inside authz.require), then owner.
  perform authz.require('inventory.lot.set_cost');
  if not authz.is_owner() then
    raise exception 'OWNER_ONLY: only the owner sets an unknown lot cost' using errcode = '42501';
  end if;

  if p_idempotency_key is null then
    raise exception 'VALIDATION: idempotency key is required' using errcode = 'P0001';
  end if;
  if p_unit_cost is null or p_unit_cost <= 0 then
    raise exception 'VALIDATION: the unit cost must be more than 0' using errcode = 'P0001';
  end if;
  if p_unit_cost <> round(p_unit_cost, 2) or p_unit_cost > 999999999999.99 then
    raise exception 'VALIDATION: the unit cost is an amount in EGP with at most 2 decimals' using errcode = 'P0001';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception 'VALIDATION: the reason must be 3-500 characters' using errcode = 'P0001';
  end if;

  select * into v_lot from inventory.lots where id = p_lot_id for update;
  if not found then raise exception 'NOT_FOUND: lot' using errcode = 'P0002'; end if;
  select v.sku into v_sku from catalog.product_variants v where v.id = v_lot.variant_id;

  select * into v_set from inventory.lot_costs where lot_id = v_lot.id;
  if found then
    if v_set.idempotency_key = p_idempotency_key and v_set.unit_cost = p_unit_cost then
      return jsonb_build_object('lot_id', v_lot.id, 'variant_id', v_lot.variant_id, 'unit_cost', v_set.unit_cost,
                                'cost_status', 'set', 'set_at', v_set.set_at, 'replayed', true);
    end if;
    raise exception 'COST_ALREADY_SET: this lot''s cost was already set; a known cost is never changed' using errcode = 'P0001';
  end if;
  if exists (select 1 from inventory.lot_costs lc where lc.idempotency_key = p_idempotency_key) then
    raise exception 'CONFLICT: this idempotency key was used for another lot' using errcode = 'P0001';
  end if;
  if not exists (select 1 from inventory.movements m
                 where m.lot_id = v_lot.id and m.movement_type = 'receipt' and m.unit_cost is null) then
    raise exception 'COST_ALREADY_SET: this lot has no units with an unknown cost' using errcode = 'P0001';
  end if;

  insert into inventory.lot_costs (lot_id, unit_cost, reason, idempotency_key, set_by)
  values (v_lot.id, p_unit_cost, v_reason, p_idempotency_key, auth.uid())
  returning * into v_set;

  -- No amount in the event: costs are never shown to reps or sent to automations.
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('inventory.lot_cost_set', 'inventory.lot', v_lot.id,
          jsonb_build_object('lot_id', v_lot.id, 'variant_id', v_lot.variant_id, 'sku', v_sku, 'lot_no', v_lot.lot_no));

  return jsonb_build_object('lot_id', v_lot.id, 'variant_id', v_lot.variant_id, 'unit_cost', v_set.unit_cost,
                            'cost_status', 'set', 'set_at', v_set.set_at, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Reads (security_invoker)
-- ---------------------------------------------------------------------------
-- One row per received lot. unit_cost: the owner's cost when set, the latest receipt cost when known,
-- NULL when unknown. Rows only for catalog.cost.read holders with company-wide movement access, so
-- the status is computed from every receipt of the lot (reps hold neither).
create or replace view api.v_lot_costs with (security_invoker = true) as
  with r as (
    select m.lot_id,
           bool_or(m.unit_cost is null) as has_unknown,
           (array_agg(m.unit_cost order by m.created_at desc, m.id desc) filter (where m.unit_cost is not null))[1] as last_cost,
           sum(m.quantity)::int as received_qty
    from inventory.movements m
    where m.movement_type = 'receipt'
    group by m.lot_id
  )
  select l.id as lot_id, l.variant_id, v.sku, v.name_en as variant_name, v.product_id, l.lot_no, l.expiry_date,
         (case when lc.lot_id is not null then 'set' when r.has_unknown then 'unknown' else 'known' end)::text as cost_status,
         (case when lc.lot_id is not null then lc.unit_cost when r.has_unknown then null else r.last_cost end)::numeric(14,2) as unit_cost,
         r.received_qty, lc.set_at as cost_set_at, lc.set_by as cost_set_by
  from r
  join inventory.lots l on l.id = r.lot_id
  join catalog.product_variants v on v.id = l.variant_id
  left join inventory.lot_costs lc on lc.lot_id = l.id
  where (select authz.has_permission('catalog.cost.read'))
    and (select authz.has_global('inventory.movement.read'));

-- From 20261126000300_phase_p_legacy_import.sql. Change: an "item without cost" (cost_unknown) also
-- leaves the list once none of its lots has units with an unknown cost left (api.set_lot_cost).
create or replace view api.v_legacy_import_quality with (security_invoker = true) as
  select st.session_id, gap.issue, 'customer'::text as entity_type, c.id as entity_id, c.id as customer_id,
         null::uuid as product_id, c.customer_no as code, c.display_name as label
  from import.legacy_session_steps st
  join import.rows r on r.batch_id = st.batch_id and r.status = 'committed'
  join crm.customers c on c.id = (r.result ->> 'customer_id')::uuid and c.archived_at is null
  cross join lateral (values ('phone_missing', c.phone_primary is null), ('location_missing', c.latitude is null)) gap(issue, hit)
  where st.kind = 'customers' and gap.hit
  union all
  select distinct st.session_id, 'cost_unknown'::text, 'product'::text, v.id, null::uuid, v.product_id, v.sku, v.name_en
  from import.legacy_session_steps st
  join import.rows r on r.batch_id = st.batch_id and r.status = 'committed'
                    and coalesce((r.normalized ->> 'cost_unknown')::boolean, false)
  join catalog.product_variants v on v.id = (r.normalized ->> 'variant_id')::uuid
  where st.kind = 'opening_stock'
    and (select authz.has_permission('catalog.cost.read'))
    and not exists (select 1 from catalog.product_costs pc
                    where pc.variant_id = v.id and pc.effective_from <= (select core.business_date()))
    and exists (select 1 from inventory.movements m
                where m.variant_id = v.id and m.movement_type = 'receipt' and m.unit_cost is null
                  and not exists (select 1 from inventory.lot_costs lc where lc.lot_id = m.lot_id));

-- ---------------------------------------------------------------------------
-- 5. Privileges (explicit; PostgreSQL's global PUBLIC execute revoked, gotcha of suite 08)
-- ---------------------------------------------------------------------------
grant select on api.v_lot_costs, api.v_legacy_import_quality to authenticated;
revoke all on api.v_lot_costs, api.v_legacy_import_quality from anon;
revoke execute on function api.set_lot_cost(uuid, numeric, text, uuid) from public, anon;
grant execute on function api.set_lot_cost(uuid, numeric, text, uuid) to authenticated;
