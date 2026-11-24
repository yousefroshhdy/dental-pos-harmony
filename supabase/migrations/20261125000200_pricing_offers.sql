-- Honest OS migration: Phase P step 6, part 1 — offers/packages, bonus lines, net prices,
-- invoice-level discounts, decision-B discount tiers and per-product VAT (schema + admin).
--
-- How HONEST sells (old system invoices): free package items (kits, abutments,
-- scan bodies), deep fixed discounts, net prices typed by the seller, and one
-- implant at several prices. Decisions B and C (docs/DECISIONS.md Part C, 2026-11-24) bind this.
--
-- Contents
--   1. Permission sales.offer.manage (owner implicitly; no explicit role grant — suite 08)
--   2. Settings: sales.discount.limit_mode / rep_max_pct / manager_max_pct (owner-only)
--   3. Offers: sales.offers, sales.offer_items, sales.offer_customers (+ RLS, audit)
--   4. Columns (expand only): order lines (bonus, offer, net price, invoice-discount share, manual %),
--      orders (invoice discount input), invoice lines (bonus), products (VAT range CHECK)
--   5. Approval routing for decision B: above the manager tier → the owner role
--   6. Helpers: sales.discount_policy, sales.offer_problem
--   7. Commands: api.upsert_offer, api.set_offer_active, api.eligible_offers, api.set_product_vat_rate
--   8. Views: api.v_offers, api.v_offer_items, api.v_offer_customers
--   9. Privileges
-- Order pricing, draft, submit, preview and invoice issue are in 20261125000210_pricing_orders.sql.
--
-- Rules: every function `set search_path = ''`; commands are SECURITY DEFINER with authz.require /
-- owner checks; errors `CODE: message` (42501 / P0001 / P0002). Additive only: new tables, columns
-- with defaults, one CHECK, reference rows, functions and views.

-- ---------------------------------------------------------------------------
-- 1. Permission
-- ---------------------------------------------------------------------------
insert into authz.permissions (code, module, description, allowed_scopes, supports_limit, is_sensitive) values
  ('sales.offer.manage', 'sales', 'Define offers and packages (prices, bonus items, validity, targeting)', '{all}', false, true)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Settings (decision B). Owner-only: they decide who may give how much money away.
--    per_role (default): each role's own limit on sales.discount.apply / wf.decide.order_discount,
--                        as before this migration (the fixture suites rely on it).
--    tiered:             reps up to rep_max_pct, sales managers (holders of wf.decide.order_discount,
--                        i.e. the sales director and area managers) up to manager_max_pct, the owner above.
-- ---------------------------------------------------------------------------
insert into core.setting_definitions
  (key, group_code, value_type, min_value, max_value, allowed_values, default_value, unit, owner_only, is_editable,
   label_en, label_ar, description_en, description_ar, sort_order) values
  ('sales.discount.limit_mode', 'sales', 'enum', null, null, array['per_role','tiered'], '"per_role"', null, true, true,
   'Discount limits', 'حدود الخصم',
   'per_role: each role''s own discount limit. tiered (decision B): reps up to the rep limit, sales managers up to the manager limit, the owner above. Offers never need approval.',
   'per_role: حد الخصم لكل دور. tiered (القرار B): المندوب حتى حد المندوب، ومدير المبيعات حتى حد المدير، والمالك فوق ذلك. العروض لا تحتاج موافقة.', 20),
  ('sales.discount.rep_max_pct', 'sales', 'number', 0, 100, null, '0', '%', true, true,
   'Rep discount limit', 'حد خصم المندوب',
   'Tiered mode: the largest manual discount a representative gives without approval.',
   'في وضع الشرائح: أكبر خصم يدوي يمنحه المندوب دون موافقة.', 30),
  ('sales.discount.manager_max_pct', 'sales', 'number', 0, 100, null, '25', '%', true, true,
   'Sales manager discount limit', 'حد خصم مدير المبيعات',
   'Tiered mode: the largest manual discount a sales manager gives or approves; above it only the owner approves.',
   'في وضع الشرائح: أكبر خصم يدوي يمنحه أو يعتمده مدير المبيعات؛ وما فوقه يعتمده المالك فقط.', 40)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Offers
-- ---------------------------------------------------------------------------
-- An owner-defined deal: items and quantities with EITHER one package price (spread over the paid
-- lines by list value) OR a net unit price per paid line, plus bonus (free) items, a validity window
-- (Cairo business days) and optional targeting (named customers and/or customer tags as tiers).
-- Picking it on an order needs no approval (decision B); validity and targeting are re-checked at submit.
create table sales.offers (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique check (code ~ '^[A-Z0-9][A-Z0-9._-]{1,39}$'),
  name_en       text not null check (length(name_en) between 2 and 160),
  name_ar       text check (length(name_ar) <= 160),
  description   text check (length(description) <= 2000),
  pricing_mode  text not null check (pricing_mode in ('package','per_line')),
  package_price core.money check (package_price > 0),       -- package mode: price of ONE package, before VAT
  valid_from    date not null,
  valid_to      date,
  target_tags   text[] not null default '{}',               -- a customer with any of these tags qualifies
  is_active     boolean not null default true,
  version       int not null default 1,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from),
  check ((pricing_mode = 'package') = (package_price is not null))
);
create index on sales.offers (created_by);
comment on table sales.offers is
  'Owner-defined offers/packages (decision B). Written only by api.upsert_offer / api.set_offer_active.';

create table sales.offer_items (
  id             uuid primary key default gen_random_uuid(),
  offer_id       uuid not null references sales.offers(id),
  line_no        int not null check (line_no between 1 and 200),
  variant_id     uuid not null references catalog.product_variants(id),
  quantity       int not null check (quantity between 1 and 100000),   -- per package
  is_bonus       boolean not null default false,
  net_unit_price core.money check (net_unit_price > 0),                -- per_line mode, paid lines only
  unique (offer_id, line_no),
  unique (offer_id, variant_id, is_bonus),
  check (not is_bonus or net_unit_price is null)
);
create index on sales.offer_items (variant_id);           -- (offer_id) is covered by the unique keys

create table sales.offer_customers (
  offer_id    uuid not null references sales.offers(id),
  customer_id uuid not null references crm.customers(id),
  primary key (offer_id, customer_id)
);
create index on sales.offer_customers (customer_id);

do $$
declare t text;
begin
  foreach t in array array['sales.offers','sales.offer_items','sales.offer_customers'] loop
    execute format('create trigger trg_audit after insert or update or delete on %s for each row execute function audit.log_change()', t);
    execute format('alter table %s enable row level security', t);
    execute format('grant select on %s to authenticated', t);
  end loop;
end $$;

-- Offers are read by whoever sells or prices; a customer target only when the customer is visible.
create policy offers_select on sales.offers for select to authenticated using (
  (select authz.has_permission('catalog.price.read')) or (select authz.has_permission('sales.order.create'))
  or (select authz.has_permission('sales.offer.manage'))
);
create policy offer_items_select on sales.offer_items for select to authenticated using (
  exists (select 1 from sales.offers o where o.id = offer_items.offer_id)
);
create policy offer_customers_select on sales.offer_customers for select to authenticated using (
  exists (select 1 from sales.offers o where o.id = offer_customers.offer_id)
  and exists (select 1 from crm.customers c where c.id = offer_customers.customer_id)
);

-- ---------------------------------------------------------------------------
-- 4. Columns (expand only)
-- ---------------------------------------------------------------------------
alter table sales.order_items add column if not exists is_bonus boolean not null default false;
alter table sales.order_items add column if not exists offer_id uuid references sales.offers(id);
alter table sales.order_items add column if not exists offer_packages int check (offer_packages between 1 and 100000);
alter table sales.order_items add column if not exists requested_net_price core.money check (requested_net_price > 0);
alter table sales.order_items add column if not exists invoice_discount_share core.money not null default 0
  check (invoice_discount_share >= 0);
alter table sales.order_items add column if not exists manual_discount_pct numeric(5,2) not null default 0
  check (manual_discount_pct between 0 and 100);
alter table sales.order_items add constraint order_items_offer_packages_chk check ((offer_id is null) = (offer_packages is null));
alter table sales.order_items add constraint order_items_bonus_free_chk check (not is_bonus or (list_price = 0 and line_total = 0));
create index if not exists idx_order_items_offer on sales.order_items (offer_id) where offer_id is not null;
comment on column sales.order_items.is_bonus is 'Free item (price 0): from an offer, or manual with sales-manager approval. Counts for stock and reports; no commission (line_total 0).';
comment on column sales.order_items.requested_net_price is 'Net unit price the seller typed (before VAT); the server converts it to the discount.';
comment on column sales.order_items.invoice_discount_share is 'This line''s share of the order''s invoice-level discount (part of line_discount).';
comment on column sales.order_items.manual_discount_pct is 'Manual discount beyond promotion/offer, incl. the invoice-discount share, as % of the line (2 decimals): compared to the limits.';

alter table sales.orders add column if not exists invoice_discount_amount core.money check (invoice_discount_amount > 0);
alter table sales.orders add column if not exists invoice_discount_pct numeric(5,2) check (invoice_discount_pct > 0 and invoice_discount_pct <= 100);
alter table sales.orders add constraint orders_invoice_discount_one_chk
  check (invoice_discount_amount is null or invoice_discount_pct is null);

alter table finance.invoice_items add column if not exists is_bonus boolean not null default false;

-- VAT is a percentage (decision C). Existing rows are 14 (or the setting default); validated now.
alter table catalog.products add constraint products_tax_rate_range_chk check (tax_rate_pct between 0 and 100);

-- ---------------------------------------------------------------------------
-- 5. Approval routing (decision B, tiered mode): a manual discount above the manager tier needs the
--    owner. submit_order sets payload.owner_required; these rules sort before the existing ones
--    (40 credit+discount, 50 credit, 100 catch-all) and never match without that flag.
--      30: owner_required AND credit exceeded → finance (wf.decide.credit_limit), then the owner role
--      35: owner_required                     → the owner role
-- ---------------------------------------------------------------------------
with d as (select id from wf.workflow_definitions where code = 'sales.order.discount'),
rules as (
  insert into wf.workflow_rules (definition_id, priority, condition)
  select d.id, v.priority, v.cond::jsonb from d,
  (values (30, '{"all":[{"field":"owner_required","op":"=","value":true},{"field":"credit_exceeded","op":"=","value":true}]}'),
          (35, '{"all":[{"field":"owner_required","op":"=","value":true}]}')) as v(priority, cond)
  on conflict (definition_id, priority) do nothing
  returning id, priority
)
insert into wf.workflow_stages (rule_id, stage_no, approver_type, approver_permission, approver_role_id)
select rules.id, s.stage_no, s.kind, s.perm, case when s.kind = 'role' then (select id from authz.roles where code = 'owner') end
from rules join (values (30, 1, 'permission', 'wf.decide.credit_limit'), (30, 2, 'role', null),
                        (35, 1, 'role', null)) as s(priority, stage_no, kind, perm)
  on s.priority = rules.priority;

-- ---------------------------------------------------------------------------
-- 6. Helpers (internal)
-- ---------------------------------------------------------------------------
-- The discount policy as stored (or defaulted) in settings.
create or replace function sales.discount_policy(out o_mode text, out o_rep_max numeric, out o_manager_max numeric)
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.value #>> '{}' from core.system_settings s where s.key = 'sales.discount.limit_mode'),
                  (select d.default_value #>> '{}' from core.setting_definitions d where d.key = 'sales.discount.limit_mode'),
                  'per_role'),
         coalesce((select (s.value #>> '{}')::numeric from core.system_settings s where s.key = 'sales.discount.rep_max_pct'),
                  (select (d.default_value #>> '{}')::numeric from core.setting_definitions d where d.key = 'sales.discount.rep_max_pct'),
                  0),
         coalesce((select (s.value #>> '{}')::numeric from core.system_settings s where s.key = 'sales.discount.manager_max_pct'),
                  (select (d.default_value #>> '{}')::numeric from core.setting_definitions d where d.key = 'sales.discount.manager_max_pct'),
                  25)
$$;

-- Why an offer cannot be used for a customer on a day (NULL = it can):
-- OFFER_INACTIVE · OFFER_NOT_STARTED · OFFER_EXPIRED · OFFER_NOT_ELIGIBLE (targeting).
create or replace function sales.offer_problem(p_offer_id uuid, p_customer_id uuid, p_on date) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when o.id is null then 'NOT_FOUND'
    when not o.is_active then 'OFFER_INACTIVE'
    when p_on < o.valid_from then 'OFFER_NOT_STARTED'
    when o.valid_to is not null and p_on > o.valid_to then 'OFFER_EXPIRED'
    when (exists (select 1 from sales.offer_customers oc where oc.offer_id = o.id) or cardinality(o.target_tags) > 0)
         and not exists (select 1 from sales.offer_customers oc where oc.offer_id = o.id and oc.customer_id = p_customer_id)
         and not exists (select 1 from crm.customers c where c.id = p_customer_id and c.tags && o.target_tags)
      then 'OFFER_NOT_ELIGIBLE'
  end
  from (select 1) one left join sales.offers o on o.id = p_offer_id
$$;

-- ---------------------------------------------------------------------------
-- 7. Commands
-- ---------------------------------------------------------------------------
-- Create (client-generated id) or replace an offer: header, items and customer targets in one call.
-- Items: [{"variant_id", "quantity", "is_bonus"?, "net_unit_price"?}] (per package, at most 50).
create or replace function api.upsert_offer(
  p_offer_id uuid, p_code text, p_name_en text, p_name_ar text, p_pricing_mode text, p_package_price numeric,
  p_valid_from date, p_valid_to date, p_items jsonb,
  p_customer_ids uuid[] default null, p_target_tags text[] default null, p_description text default null,
  p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_name_en text := nullif(btrim(p_name_en), '');
  v_name_ar text := nullif(btrim(p_name_ar), '');
  v_desc text := nullif(btrim(p_description), '');
  v_tags text[];
  v_old sales.offers%rowtype; v_created boolean; v_version int;
  v_rec record; v_variant uuid; v_qty numeric; v_bonus boolean; v_net numeric; v_paid int := 0;
  v_seen text[] := '{}'; v_key text;
begin
  perform authz.require('sales.offer.manage');
  if not authz.has_global('sales.offer.manage') then
    raise exception 'PERMISSION_DENIED: sales.offer.manage needs company-wide scope' using errcode = '42501';
  end if;
  if p_offer_id is null then raise exception 'VALIDATION: offer id is required' using errcode = 'P0001'; end if;
  if v_code !~ '^[A-Z0-9][A-Z0-9._-]{1,39}$' then
    raise exception 'VALIDATION: offer code must be 2-40 letters, digits, dots, dashes or underscores' using errcode = 'P0001';
  end if;
  if v_name_en is null or length(v_name_en) < 2 or length(v_name_en) > 160 then
    raise exception 'VALIDATION: English name must be 2-160 characters' using errcode = 'P0001';
  end if;
  if length(v_name_ar) > 160 or length(v_desc) > 2000 then
    raise exception 'VALIDATION: Arabic name at most 160 and description at most 2000 characters' using errcode = 'P0001';
  end if;
  if p_pricing_mode is null or p_pricing_mode not in ('package', 'per_line') then
    raise exception 'VALIDATION: pricing mode is package or per_line' using errcode = 'P0001';
  end if;
  if p_pricing_mode = 'package' then
    if p_package_price is null or p_package_price <= 0 or p_package_price <> round(p_package_price, 2) or p_package_price > 999999999999.99 then
      raise exception 'VALIDATION: a package needs a price above 0 with at most 2 decimals' using errcode = 'P0001';
    end if;
  elsif p_package_price is not null then
    raise exception 'VALIDATION: a per-line offer has no package price' using errcode = 'P0001';
  end if;
  if p_valid_from is null then raise exception 'VALIDATION: the offer needs a start date' using errcode = 'P0001'; end if;
  if p_valid_to is not null and p_valid_to < p_valid_from then
    raise exception 'VALIDATION: the offer cannot end before it starts' using errcode = 'P0001';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 50 then
    raise exception 'VALIDATION: an offer has 1 to 50 items' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(distinct t order by t), '{}') into v_tags
  from unnest(coalesce(p_target_tags, '{}')) as u(x), lateral (select nullif(btrim(u.x), '') as t) s where s.t is not null;
  if cardinality(v_tags) > 20 or exists (select 1 from unnest(v_tags) t where length(t) > 60) then
    raise exception 'VALIDATION: at most 20 target tags of 60 characters' using errcode = 'P0001';
  end if;
  if cardinality(coalesce(p_customer_ids, '{}')) > 500 then
    raise exception 'VALIDATION: at most 500 target customers' using errcode = 'P0001';
  end if;
  if exists (select 1 from unnest(coalesce(p_customer_ids, '{}')) c(id)
             where c.id is null or not exists (select 1 from crm.customers x where x.id = c.id)) then
    raise exception 'NOT_FOUND: a target customer does not exist' using errcode = 'P0002';
  end if;

  -- Items: validated before anything is written.
  for v_rec in select e.item, e.n from jsonb_array_elements(p_items) with ordinality as e(item, n) loop
    if jsonb_typeof(v_rec.item) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_rec.item) k where k not in ('variant_id','quantity','is_bonus','net_unit_price')) then
      raise exception 'VALIDATION: item % may only contain variant_id, quantity, is_bonus, net_unit_price', v_rec.n using errcode = 'P0001';
    end if;
    v_variant := core.try_cast_uuid(v_rec.item ->> 'variant_id');
    if v_variant is null then raise exception 'VALIDATION: item % has no valid variant_id', v_rec.n using errcode = 'P0001'; end if;
    if not exists (select 1 from catalog.product_variants pv join catalog.products p on p.id = pv.product_id
                   where pv.id = v_variant and pv.status = 'active' and p.status = 'active') then
      raise exception 'NOT_FOUND: item % is not a sellable variant', v_rec.n using errcode = 'P0002';
    end if;
    if jsonb_typeof(v_rec.item -> 'quantity') is distinct from 'number' then
      raise exception 'VALIDATION: item % quantity must be a number', v_rec.n using errcode = 'P0001';
    end if;
    v_qty := (v_rec.item ->> 'quantity')::numeric;
    if v_qty <> trunc(v_qty) or v_qty < 1 or v_qty > 100000 then
      raise exception 'VALIDATION: item % quantity must be a whole number between 1 and 100000', v_rec.n using errcode = 'P0001';
    end if;
    if coalesce(jsonb_typeof(v_rec.item -> 'is_bonus'), 'null') not in ('null', 'boolean') then
      raise exception 'VALIDATION: item % is_bonus must be true or false', v_rec.n using errcode = 'P0001';
    end if;
    v_bonus := coalesce((v_rec.item ->> 'is_bonus')::boolean, false);
    if coalesce(jsonb_typeof(v_rec.item -> 'net_unit_price'), 'null') = 'null' then
      v_net := null;
    elsif jsonb_typeof(v_rec.item -> 'net_unit_price') <> 'number' then
      raise exception 'VALIDATION: item % net price must be a number', v_rec.n using errcode = 'P0001';
    else
      v_net := (v_rec.item ->> 'net_unit_price')::numeric;
      if v_net <= 0 or v_net <> round(v_net, 2) or v_net > 999999999999.99 then
        raise exception 'VALIDATION: item % net price must be above 0 with at most 2 decimals', v_rec.n using errcode = 'P0001';
      end if;
    end if;
    if v_bonus and v_net is not null then
      raise exception 'VALIDATION: item % is a bonus (free) line and has no price', v_rec.n using errcode = 'P0001';
    end if;
    if not v_bonus then
      v_paid := v_paid + 1;
      if p_pricing_mode = 'package' and v_net is not null then
        raise exception 'VALIDATION: item % — a package has one price, not per-line prices', v_rec.n using errcode = 'P0001';
      end if;
      if p_pricing_mode = 'per_line' and v_net is null then
        raise exception 'VALIDATION: item % needs a net unit price (per-line offer)', v_rec.n using errcode = 'P0001';
      end if;
    end if;
    v_key := v_variant::text || ':' || v_bonus::text;
    if v_key = any(v_seen) then
      raise exception 'VALIDATION: item % repeats a variant (raise its quantity instead)', v_rec.n using errcode = 'P0001';
    end if;
    v_seen := v_seen || v_key;
  end loop;
  if v_paid = 0 then raise exception 'VALIDATION: an offer needs at least one paid line' using errcode = 'P0001'; end if;

  select * into v_old from sales.offers where id = p_offer_id for update;
  v_created := not found;
  if exists (select 1 from sales.offers where code = v_code and id <> p_offer_id) then
    raise exception 'DUPLICATE_CODE: offer code % is already used', v_code using errcode = 'P0001';
  end if;
  if not v_created and p_expected_version is not null and p_expected_version <> v_old.version then
    raise exception 'CONFLICT: offer changed (current version %)', v_old.version using errcode = 'P0001';
  end if;

  begin
    if v_created then
      insert into sales.offers (id, code, name_en, name_ar, description, pricing_mode, package_price, valid_from, valid_to,
                                target_tags, created_by)
      values (p_offer_id, v_code, v_name_en, v_name_ar, v_desc, p_pricing_mode, p_package_price, p_valid_from, p_valid_to,
              v_tags, auth.uid())
      returning version into v_version;
    else
      update sales.offers set code = v_code, name_en = v_name_en, name_ar = v_name_ar, description = v_desc,
             pricing_mode = p_pricing_mode, package_price = p_package_price, valid_from = p_valid_from, valid_to = p_valid_to,
             target_tags = v_tags, version = version + 1, updated_at = now()
      where id = p_offer_id returning version into v_version;
      -- Configuration rows of the offer (audited); orders keep their own priced lines.
      delete from sales.offer_items where offer_id = p_offer_id;
      delete from sales.offer_customers where offer_id = p_offer_id;
    end if;
  exception when unique_violation then
    raise exception 'DUPLICATE_CODE: offer code % is already used', v_code using errcode = 'P0001';
  end;

  insert into sales.offer_items (offer_id, line_no, variant_id, quantity, is_bonus, net_unit_price)
  select p_offer_id, e.n, (e.item ->> 'variant_id')::uuid, (e.item ->> 'quantity')::numeric::int,
         coalesce((e.item ->> 'is_bonus')::boolean, false), (e.item ->> 'net_unit_price')::numeric
  from jsonb_array_elements(p_items) with ordinality as e(item, n);
  insert into sales.offer_customers (offer_id, customer_id)
  select distinct p_offer_id, c.id from unnest(coalesce(p_customer_ids, '{}')) c(id);

  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values (case when v_created then 'offer.created' else 'offer.updated' end, 'sales.offer', p_offer_id,
          jsonb_build_object('offer_id', p_offer_id, 'code', v_code, 'pricing_mode', p_pricing_mode,
                             'valid_from', p_valid_from, 'valid_to', p_valid_to, 'version', v_version));
  return jsonb_build_object('offer_id', p_offer_id, 'code', v_code, 'version', v_version, 'created', v_created);
end $$;

-- Start or end an offer (orders already submitted keep their prices).
create or replace function api.set_offer_active(p_offer_id uuid, p_active boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v sales.offers%rowtype;
begin
  perform authz.require('sales.offer.manage');
  if not authz.has_global('sales.offer.manage') then
    raise exception 'PERMISSION_DENIED: sales.offer.manage needs company-wide scope' using errcode = '42501';
  end if;
  if p_active is null then raise exception 'VALIDATION: active is true or false' using errcode = 'P0001'; end if;
  select * into v from sales.offers where id = p_offer_id for update;
  if not found then raise exception 'NOT_FOUND: offer' using errcode = 'P0002'; end if;
  if v.is_active = p_active then
    return jsonb_build_object('offer_id', p_offer_id, 'is_active', p_active, 'changed', false, 'version', v.version);
  end if;
  update sales.offers set is_active = p_active, version = version + 1, updated_at = now()
  where id = p_offer_id returning * into v;
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('offer.updated', 'sales.offer', p_offer_id,
          jsonb_build_object('offer_id', p_offer_id, 'code', v.code, 'is_active', p_active, 'version', v.version));
  return jsonb_build_object('offer_id', p_offer_id, 'is_active', p_active, 'changed', true, 'version', v.version);
end $$;

-- The offers a seller may pick today for one customer in their scope, with items and indicative
-- prices (the server prices the order again on every save and at submit).
create or replace function api.eligible_offers(p_customer_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_today date := core.business_date();
begin
  perform authz.require('sales.order.create');
  if not exists (select 1 from crm.customers where id = p_customer_id) then
    raise exception 'NOT_FOUND: customer' using errcode = 'P0002';
  end if;
  if not authz.customer_in_scope('crm.customer.read', p_customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'offer_id', o.id, 'code', o.code, 'name_en', o.name_en, 'name_ar', o.name_ar, 'description', o.description,
             'pricing_mode', o.pricing_mode, 'package_price', o.package_price, 'valid_from', o.valid_from,
             'valid_to', o.valid_to, 'version', o.version,
             'items', (select coalesce(jsonb_agg(jsonb_build_object(
                                'line_no', i.line_no, 'variant_id', i.variant_id, 'sku', v.sku, 'variant_name', v.name_en,
                                'quantity', i.quantity, 'is_bonus', i.is_bonus, 'net_unit_price', i.net_unit_price)
                              order by i.line_no), '[]'::jsonb)
                       from sales.offer_items i join catalog.product_variants v on v.id = i.variant_id
                       where i.offer_id = o.id))
           order by o.code)
    from sales.offers o
    where sales.offer_problem(o.id, p_customer_id, v_today) is null), '[]'::jsonb);
end $$;

-- Per-product VAT (decision C): owner only, audited (row trigger + security event), outbox event.
-- Drafts pick the new rate at their next save/submit; submitted orders and issued invoices keep the
-- rate they were priced with (stored on each line).
create or replace function api.set_product_vat_rate(p_product_id uuid, p_vat_rate_pct numeric, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_old catalog.products%rowtype;
begin
  if not authz.is_owner() then
    raise exception 'OWNER_ONLY: only the owner sets VAT rates' using errcode = '42501';
  end if;
  perform authz.require('catalog.product.manage');   -- implicit for the owner; keeps the audit trail of the check
  if p_vat_rate_pct is null or p_vat_rate_pct < 0 or p_vat_rate_pct > 100 or p_vat_rate_pct <> round(p_vat_rate_pct, 2) then
    raise exception 'VALIDATION: VAT is a percentage from 0 to 100 with at most 2 decimals' using errcode = 'P0001';
  end if;
  if p_reason is not null and length(p_reason) > 500 then
    raise exception 'VALIDATION: reason is too long' using errcode = 'P0001';
  end if;
  select * into v_old from catalog.products where id = p_product_id for update;
  if not found then raise exception 'NOT_FOUND: product' using errcode = 'P0002'; end if;
  if v_old.tax_rate_pct = p_vat_rate_pct then
    return jsonb_build_object('product_id', p_product_id, 'vat_rate_pct', v_old.tax_rate_pct, 'changed', false);
  end if;
  update catalog.products set tax_rate_pct = p_vat_rate_pct, updated_at = now() where id = p_product_id;
  perform authz.log_security_event('product_vat_changed', 'warning',
    jsonb_build_object('product_id', p_product_id, 'code', v_old.code, 'old', v_old.tax_rate_pct, 'new', p_vat_rate_pct,
                       'reason', nullif(btrim(p_reason), '')));
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('product.vat_changed', 'catalog.product', p_product_id,
          jsonb_build_object('product_id', p_product_id, 'code', v_old.code, 'vat_rate_pct', p_vat_rate_pct));
  return jsonb_build_object('product_id', p_product_id, 'vat_rate_pct', p_vat_rate_pct, 'changed', true);
end $$;

-- ---------------------------------------------------------------------------
-- 8. Views (security_invoker: the caller's RLS applies)
-- ---------------------------------------------------------------------------
create or replace view api.v_offers with (security_invoker = true) as
  select o.id, o.code, o.name_en, o.name_ar, o.description, o.pricing_mode, o.package_price,
         o.valid_from, o.valid_to, o.target_tags, o.is_active, o.version, o.created_at, o.updated_at,
         (o.is_active and core.business_date() >= o.valid_from and (o.valid_to is null or core.business_date() <= o.valid_to)) as is_current,
         (select count(*) from sales.offer_items i where i.offer_id = o.id and not i.is_bonus)::int as paid_items,
         (select count(*) from sales.offer_items i where i.offer_id = o.id and i.is_bonus)::int as bonus_items,
         (select count(*) from sales.offer_customers c where c.offer_id = o.id)::int as target_customer_count,
         (exists (select 1 from sales.offer_customers c where c.offer_id = o.id) or cardinality(o.target_tags) > 0) as is_targeted
  from sales.offers o;

create or replace view api.v_offer_items with (security_invoker = true) as
  select i.id, i.offer_id, o.code as offer_code, i.line_no, i.variant_id, v.sku, v.name_en as variant_name,
         p.name_en as product_name_en, p.name_ar as product_name_ar, i.quantity, i.is_bonus, i.net_unit_price
  from sales.offer_items i
  join sales.offers o on o.id = i.offer_id
  join catalog.product_variants v on v.id = i.variant_id
  join catalog.products p on p.id = v.product_id;

create or replace view api.v_offer_customers with (security_invoker = true) as
  select oc.offer_id, oc.customer_id, c.customer_no, c.display_name as customer_name
  from sales.offer_customers oc
  join crm.customers c on c.id = oc.customer_id;

-- ---------------------------------------------------------------------------
-- 9. Privileges (PostgreSQL grants PUBLIC execute by default: revoke explicitly)
-- ---------------------------------------------------------------------------
revoke execute on function sales.discount_policy() from public, anon, authenticated;
revoke execute on function sales.offer_problem(uuid, uuid, date) from public, anon, authenticated;
revoke execute on function api.upsert_offer(uuid, text, text, text, text, numeric, date, date, jsonb, uuid[], text[], text, int) from public, anon;
revoke execute on function api.set_offer_active(uuid, boolean) from public, anon;
revoke execute on function api.eligible_offers(uuid) from public, anon;
revoke execute on function api.set_product_vat_rate(uuid, numeric, text) from public, anon;
grant execute on function api.upsert_offer(uuid, text, text, text, text, numeric, date, date, jsonb, uuid[], text[], text, int) to authenticated;
grant execute on function api.set_offer_active(uuid, boolean) to authenticated;
grant execute on function api.eligible_offers(uuid) to authenticated;
grant execute on function api.set_product_vat_rate(uuid, numeric, text) to authenticated;

grant select on api.v_offers, api.v_offer_items, api.v_offer_customers to authenticated;
revoke all on api.v_offers, api.v_offer_items, api.v_offer_customers from anon;
