-- Honest OS migration: Phase 3 catalogue administration (ROADMAP Phase 3 task 7).
--
-- Commands (SECURITY DEFINER, authz.require + company-wide scope, structured errors):
--   products   api.upsert_product, api.set_product_status
--   variants   api.upsert_variant, api.set_variant_status
--   prices     api.upsert_price_list, api.set_price_list_item, api.remove_price_list_item
--   customers  api.assign_customer_price_list, api.end_customer_price_list
--   promotions api.create_promotion, api.end_promotion        (rows of sales.discount_rules)
-- Read views (security_invoker): api.v_catalog_brands, api.v_catalog_categories,
--   api.v_catalog_products, api.v_catalog_variants, api.v_price_lists, api.v_price_list_items,
--   api.v_customer_price_lists, api.v_promotions
-- Outbox events: product.created, product.updated, variant.created, variant.updated,
--   price_list.updated, price.changed, promotion.created, promotion.ended (no costs, no PII).
--
-- Permissions (existing codes, no new ones):
--   catalog.product.manage  products and variants        (owner, inventory_manager)
--   catalog.price.manage    price lists, items, customer price lists, promotions (owner)
-- Catalogue data is company-wide, so both need scope 'all'.
--
-- Rules worth knowing:
--   * No hard delete of products or variants: they are discontinued, which keeps every order,
--     lot and audit row that references them. Discontinued items are not sellable
--     (api.save_order_draft already refuses them).
--   * Prices are numeric(14,2) EGP, > 0, at most 2 decimals. Price list items carry no dates
--     (primary key list+variant+min_qty); effective dating is on the price list
--     (valid_from/valid_to). A scheduled price change = a new list with a later valid_from.
--   * Order lines snapshot list_price at save/submit (sales.price_order). Submitted orders are
--     never re-priced; drafts are indicative and are re-priced at submit (suite 24).
--   * VAT (tax_rate_pct) is not editable here: new products take sales.default_vat_pct (D-12).
--
-- Non-destructive only: new functions, views, policies and one audit trigger.

-- ---------------------------------------------------------------------------
-- 1. Audit and read policies for catalogue tables that had none
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_audit'
                 and tgrelid = 'catalog.customer_price_lists'::regclass) then
    create trigger trg_audit after insert or update or delete on catalog.customer_price_lists
      for each row execute function audit.log_change();
  end if;
end $$;

-- Promotions and customer price lists were deny-all. Price readers see them, but a
-- customer-specific row only when the customer itself is visible (inherits crm.customers RLS).
create policy promotions_select_price_readers on sales.discount_rules for select to authenticated using (
  (select authz.has_permission('catalog.price.read'))
  and (customer_id is null or exists (select 1 from crm.customers c where c.id = discount_rules.customer_id))
);
create policy customer_price_lists_select_price_readers on catalog.customer_price_lists for select to authenticated using (
  (select authz.has_permission('catalog.price.read'))
  and exists (select 1 from crm.customers c where c.id = customer_price_lists.customer_id)
);

-- ---------------------------------------------------------------------------
-- 2. Internal helpers (not client-callable; revoked at the end)
-- ---------------------------------------------------------------------------
-- Catalogue changes are company-wide: the permission must be held at scope 'all'.
create or replace function catalog._require_global(p_perm text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  perform authz.require(p_perm);
  if not authz.has_global(p_perm) then
    raise exception 'PERMISSION_DENIED: % needs company-wide scope', p_perm using errcode = '42501';
  end if;
end $$;

create or replace function catalog._emit(p_event_type text, p_aggregate_type text, p_aggregate_id uuid, p_payload jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values (p_event_type, p_aggregate_type, p_aggregate_id, coalesce(p_payload, '{}'))
$$;

-- Selling price rule: EGP, > 0, at most 2 decimals, fits numeric(14,2).
create or replace function catalog._check_price(p_price numeric) returns numeric
language plpgsql immutable set search_path = '' as $$
begin
  if p_price is null or p_price <= 0 then
    raise exception 'VALIDATION: price must be greater than 0' using errcode = 'P0001';
  end if;
  if p_price <> round(p_price, 2) then
    raise exception 'VALIDATION: price may have at most 2 decimals' using errcode = 'P0001';
  end if;
  if p_price > 999999999999.99 then
    raise exception 'VALIDATION: price is too large' using errcode = 'P0001';
  end if;
  return p_price;
end $$;

-- Codes (product, price list): upper case letters, digits, dot, dash, underscore.
create or replace function catalog._clean_code(p_code text, p_field text) returns text
language plpgsql immutable set search_path = '' as $$
declare v text := upper(btrim(coalesce(p_code, '')));
begin
  if v !~ '^[A-Z0-9][A-Z0-9._-]{1,39}$' then
    raise exception 'VALIDATION: % must be 2-40 letters, digits, dots, dashes or underscores', p_field using errcode = 'P0001';
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Products
-- ---------------------------------------------------------------------------
-- Create (client-generated id) or update a product's master data. Status changes go
-- through api.set_product_status; VAT is not editable here (D-12).
create or replace function api.upsert_product(
  p_product_id        uuid,
  p_brand_id          uuid,
  p_category_id       uuid,
  p_code              text,
  p_name_en           text,
  p_name_ar           text default null,
  p_description       text default null,
  p_is_lot_tracked    boolean default true,
  p_is_expiry_tracked boolean default false,
  p_is_serial_tracked boolean default false,
  p_status            text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_code text;
  v_name_en text := nullif(btrim(p_name_en), '');
  v_name_ar text := nullif(btrim(p_name_ar), '');
  v_desc text := nullif(btrim(p_description), '');
  v_old catalog.products%rowtype;
  v_new catalog.products%rowtype;
  v_created boolean;
  v_changed boolean := true;
  v_vat numeric;
begin
  perform catalog._require_global('catalog.product.manage');

  if p_product_id is null then raise exception 'VALIDATION: product id is required' using errcode = 'P0001'; end if;
  v_code := catalog._clean_code(p_code, 'product code');
  if v_name_en is null or length(v_name_en) < 2 or length(v_name_en) > 160 then
    raise exception 'VALIDATION: English name must be 2-160 characters' using errcode = 'P0001';
  end if;
  if length(v_name_ar) > 160 then
    raise exception 'VALIDATION: Arabic name must be at most 160 characters' using errcode = 'P0001';
  end if;
  if length(v_desc) > 2000 then
    raise exception 'VALIDATION: description must be at most 2000 characters' using errcode = 'P0001';
  end if;
  if p_is_lot_tracked is null or p_is_expiry_tracked is null or p_is_serial_tracked is null then
    raise exception 'VALIDATION: tracking flags are required' using errcode = 'P0001';
  end if;
  if not exists (select 1 from catalog.brands where id = p_brand_id and is_active) then
    raise exception 'VALIDATION: unknown or inactive brand' using errcode = 'P0001';
  end if;
  if not exists (select 1 from catalog.categories where id = p_category_id) then
    raise exception 'VALIDATION: unknown category' using errcode = 'P0001';
  end if;

  select * into v_old from catalog.products where id = p_product_id for update;
  v_created := not found;

  if exists (select 1 from catalog.products where upper(code) = v_code and id <> p_product_id) then
    raise exception 'DUPLICATE_CODE: product code % is already used', v_code using errcode = 'P0001';
  end if;

  begin
    if v_created then
      if coalesce(p_status, 'active') not in ('draft', 'active') then
        raise exception 'VALIDATION: a new product starts as draft or active' using errcode = 'P0001';
      end if;
      select (value #>> '{}')::numeric into v_vat from core.system_settings where key = 'sales.default_vat_pct';
      insert into catalog.products (id, brand_id, category_id, code, name_en, name_ar, description,
                                    is_lot_tracked, is_expiry_tracked, is_serial_tracked, tax_rate_pct, status)
      values (p_product_id, p_brand_id, p_category_id, v_code, v_name_en, v_name_ar, v_desc,
              p_is_lot_tracked, p_is_expiry_tracked, p_is_serial_tracked, coalesce(v_vat, 14.00),
              coalesce(p_status, 'active'))
      returning * into v_new;
    else
      if p_status is not null and p_status is distinct from v_old.status then
        raise exception 'VALIDATION: change the status with api.set_product_status' using errcode = 'P0001';
      end if;
      -- Lot / expiry tracking cannot be switched off once lots exist (traceability, recalls).
      if ((v_old.is_lot_tracked and not p_is_lot_tracked) or (v_old.is_expiry_tracked and not p_is_expiry_tracked))
         and exists (select 1 from inventory.lots l join catalog.product_variants pv on pv.id = l.variant_id
                     where pv.product_id = p_product_id) then
        raise exception 'INVALID_STATE: product has stock lots; lot and expiry tracking cannot be turned off'
          using errcode = 'P0001';
      end if;
      v_changed := (v_old.brand_id, v_old.category_id, v_old.code, v_old.name_en, v_old.name_ar, v_old.description,
                    v_old.is_lot_tracked, v_old.is_expiry_tracked, v_old.is_serial_tracked)
                   is distinct from (p_brand_id, p_category_id, v_code, v_name_en, v_name_ar, v_desc,
                                     p_is_lot_tracked, p_is_expiry_tracked, p_is_serial_tracked);
      if v_changed then
        update catalog.products set
          brand_id = p_brand_id, category_id = p_category_id, code = v_code,
          name_en = v_name_en, name_ar = v_name_ar, description = v_desc,
          is_lot_tracked = p_is_lot_tracked, is_expiry_tracked = p_is_expiry_tracked,
          is_serial_tracked = p_is_serial_tracked, updated_at = now()
        where id = p_product_id;
      end if;
      select * into v_new from catalog.products where id = p_product_id;
    end if;
  exception when unique_violation then
    raise exception 'DUPLICATE_CODE: product code % is already used', v_code using errcode = 'P0001';
  end;

  if v_changed then
    perform catalog._emit(case when v_created then 'product.created' else 'product.updated' end,
      'catalog.product', p_product_id,
      jsonb_build_object('product_id', p_product_id, 'code', v_new.code, 'name_en', v_new.name_en,
                         'name_ar', v_new.name_ar, 'brand_id', v_new.brand_id, 'category_id', v_new.category_id,
                         'status', v_new.status));
  end if;

  return jsonb_build_object('product_id', p_product_id, 'code', v_new.code, 'status', v_new.status,
                            'created', v_created);
end $$;

-- draft → active → discontinued (and back to active). Never deleted: history stays intact.
create or replace function api.set_product_status(p_product_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_old catalog.products%rowtype;
begin
  perform catalog._require_global('catalog.product.manage');
  if p_status is null or p_status not in ('draft', 'active', 'discontinued') then
    raise exception 'VALIDATION: unknown product status %', coalesce(p_status, '(none)') using errcode = 'P0001';
  end if;
  select * into v_old from catalog.products where id = p_product_id for update;
  if not found then raise exception 'NOT_FOUND: product' using errcode = 'P0002'; end if;
  if v_old.status = p_status then
    return jsonb_build_object('product_id', p_product_id, 'status', p_status, 'changed', false);
  end if;
  if p_status = 'draft' and exists (select 1 from sales.order_items oi
                                    join catalog.product_variants pv on pv.id = oi.variant_id
                                    where pv.product_id = p_product_id) then
    raise exception 'INVALID_STATE: a product that has been ordered cannot go back to draft' using errcode = 'P0001';
  end if;

  update catalog.products set status = p_status, updated_at = now() where id = p_product_id;
  perform catalog._emit('product.updated', 'catalog.product', p_product_id,
    jsonb_build_object('product_id', p_product_id, 'code', v_old.code, 'status', p_status,
                       'previous_status', v_old.status));
  return jsonb_build_object('product_id', p_product_id, 'status', p_status, 'previous_status', v_old.status,
                            'changed', true);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Variants (SKUs)
-- ---------------------------------------------------------------------------
create or replace function api.upsert_variant(
  p_variant_id    uuid,
  p_product_id    uuid,
  p_sku           text,
  p_name_en       text,
  p_attributes    jsonb default '{}',
  p_barcode       text default null,
  p_uom           text default 'unit',
  p_reorder_point int default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_sku text := upper(btrim(coalesce(p_sku, '')));
  v_name text := nullif(btrim(p_name_en), '');
  v_barcode text := nullif(btrim(p_barcode), '');
  v_uom text := lower(btrim(coalesce(p_uom, 'unit')));
  v_attrs jsonb := coalesce(p_attributes, '{}'::jsonb);
  v_product catalog.products%rowtype;
  v_old catalog.product_variants%rowtype;
  v_new catalog.product_variants%rowtype;
  v_created boolean;
begin
  perform catalog._require_global('catalog.product.manage');

  if p_variant_id is null then raise exception 'VALIDATION: variant id is required' using errcode = 'P0001'; end if;
  if v_sku !~ '^[A-Z0-9][A-Z0-9._/-]{1,63}$' then
    raise exception 'VALIDATION: SKU must be 2-64 letters, digits, dots, dashes, slashes or underscores' using errcode = 'P0001';
  end if;
  if v_name is null or length(v_name) > 160 then
    raise exception 'VALIDATION: variant name must be 1-160 characters' using errcode = 'P0001';
  end if;
  if v_barcode is not null and v_barcode !~ '^[0-9A-Za-z-]{4,64}$' then
    raise exception 'VALIDATION: barcode must be 4-64 letters, digits or dashes' using errcode = 'P0001';
  end if;
  if v_uom !~ '^[a-z][a-z_]{0,19}$' then
    raise exception 'VALIDATION: unit of measure must be 1-20 lower-case letters' using errcode = 'P0001';
  end if;
  if p_reorder_point is null or p_reorder_point < 0 or p_reorder_point > 1000000 then
    raise exception 'VALIDATION: reorder point must be between 0 and 1000000' using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_attrs) <> 'object' then
    raise exception 'VALIDATION: attributes must be a JSON object' using errcode = 'P0001';
  end if;
  if (select count(*) from jsonb_object_keys(v_attrs)) > 30
     or exists (select 1 from jsonb_each(v_attrs) e
                where e.key !~ '^[a-z][a-z0-9_]{0,39}$'
                   or jsonb_typeof(e.value) not in ('string', 'number', 'boolean')
                   or length(e.value::text) > 200) then
    raise exception 'VALIDATION: attributes need snake_case keys with short text, number or yes/no values (at most 30)'
      using errcode = 'P0001';
  end if;

  select * into v_product from catalog.products where id = p_product_id;
  if not found then raise exception 'NOT_FOUND: product' using errcode = 'P0002'; end if;

  select * into v_old from catalog.product_variants where id = p_variant_id for update;
  v_created := not found;

  if not v_created and v_old.product_id <> p_product_id then
    raise exception 'VALIDATION: a variant cannot move to another product' using errcode = 'P0001';
  end if;
  if v_created and v_product.status = 'discontinued' then
    raise exception 'INVALID_STATE: product is discontinued; reactivate it before adding variants' using errcode = 'P0001';
  end if;
  if exists (select 1 from catalog.product_variants where upper(sku) = v_sku and id <> p_variant_id) then
    raise exception 'DUPLICATE_SKU: SKU % is already used', v_sku using errcode = 'P0001';
  end if;
  if v_barcode is not null and exists (select 1 from catalog.product_variants where barcode = v_barcode and id <> p_variant_id) then
    raise exception 'DUPLICATE_BARCODE: barcode % is already used', v_barcode using errcode = 'P0001';
  end if;
  -- The SKU is what people, labels and Shopify know a variant by: frozen once it is in use.
  if not v_created and v_old.sku <> v_sku
     and (exists (select 1 from inventory.lots where variant_id = p_variant_id)
          or exists (select 1 from sales.order_items where variant_id = p_variant_id)) then
    raise exception 'INVALID_STATE: the SKU of a variant with stock or orders cannot change' using errcode = 'P0001';
  end if;

  begin
    if v_created then
      insert into catalog.product_variants (id, product_id, sku, name_en, attributes, barcode, uom, reorder_point)
      values (p_variant_id, p_product_id, v_sku, v_name, v_attrs, v_barcode, v_uom, p_reorder_point)
      returning * into v_new;
    else
      update catalog.product_variants set sku = v_sku, name_en = v_name, attributes = v_attrs,
             barcode = v_barcode, uom = v_uom, reorder_point = p_reorder_point
      where id = p_variant_id
      returning * into v_new;
    end if;
  exception when unique_violation then
    raise exception 'DUPLICATE_SKU: SKU or barcode is already used' using errcode = 'P0001';
  end;

  if v_created or (v_new.sku, v_new.name_en, v_new.attributes, v_new.barcode, v_new.uom, v_new.reorder_point)
                   is distinct from (v_old.sku, v_old.name_en, v_old.attributes, v_old.barcode, v_old.uom, v_old.reorder_point) then
    perform catalog._emit(case when v_created then 'variant.created' else 'variant.updated' end,
      'catalog.variant', p_variant_id,
      jsonb_build_object('variant_id', p_variant_id, 'product_id', p_product_id, 'product_code', v_product.code,
                         'sku', v_new.sku, 'name_en', v_new.name_en, 'barcode', v_new.barcode,
                         'uom', v_new.uom, 'status', v_new.status));
  end if;

  return jsonb_build_object('variant_id', p_variant_id, 'product_id', p_product_id, 'sku', v_new.sku,
                            'status', v_new.status, 'created', v_created);
end $$;

create or replace function api.set_variant_status(p_variant_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_old catalog.product_variants%rowtype; v_product_status text;
begin
  perform catalog._require_global('catalog.product.manage');
  if p_status is null or p_status not in ('active', 'discontinued') then
    raise exception 'VALIDATION: unknown variant status %', coalesce(p_status, '(none)') using errcode = 'P0001';
  end if;
  select * into v_old from catalog.product_variants where id = p_variant_id for update;
  if not found then raise exception 'NOT_FOUND: variant' using errcode = 'P0002'; end if;
  if v_old.status = p_status then
    return jsonb_build_object('variant_id', p_variant_id, 'status', p_status, 'changed', false);
  end if;
  select status into v_product_status from catalog.products where id = v_old.product_id;
  if p_status = 'active' and v_product_status = 'discontinued' then
    raise exception 'INVALID_STATE: product is discontinued; reactivate it first' using errcode = 'P0001';
  end if;

  update catalog.product_variants set status = p_status where id = p_variant_id;
  perform catalog._emit('variant.updated', 'catalog.variant', p_variant_id,
    jsonb_build_object('variant_id', p_variant_id, 'product_id', v_old.product_id, 'sku', v_old.sku,
                       'status', p_status, 'previous_status', v_old.status));
  return jsonb_build_object('variant_id', p_variant_id, 'status', p_status, 'previous_status', v_old.status,
                            'changed', true);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Price lists and items
-- ---------------------------------------------------------------------------
-- Create or update a list. The kind is fixed at creation (switching a customer list to
-- standard would expose its prices to every customer). DEFAULT is the fallback for every
-- order: it stays standard, active and open-ended.
create or replace function api.upsert_price_list(
  p_price_list_id uuid,
  p_code          text,
  p_name          text,
  p_kind          text default 'standard',
  p_priority      int default 100,
  p_valid_from    date default current_date,
  p_valid_to      date default null,
  p_is_active     boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_code text;
  v_name text := nullif(btrim(p_name), '');
  v_old catalog.price_lists%rowtype;
  v_new catalog.price_lists%rowtype;
  v_created boolean;
begin
  perform catalog._require_global('catalog.price.manage');

  if p_price_list_id is null then raise exception 'VALIDATION: price list id is required' using errcode = 'P0001'; end if;
  v_code := catalog._clean_code(p_code, 'price list code');
  if v_name is null or length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'VALIDATION: price list name must be 2-120 characters' using errcode = 'P0001';
  end if;
  if p_kind is null or p_kind not in ('standard', 'customer', 'promotional') then
    raise exception 'VALIDATION: unknown price list kind %', coalesce(p_kind, '(none)') using errcode = 'P0001';
  end if;
  if p_priority is null or p_priority < 1 or p_priority > 1000 then
    raise exception 'VALIDATION: priority must be between 1 and 1000' using errcode = 'P0001';
  end if;
  if p_valid_from is null then raise exception 'VALIDATION: valid from is required' using errcode = 'P0001'; end if;
  if p_valid_to is not null and p_valid_to < p_valid_from then
    raise exception 'VALIDATION: valid to must be on or after valid from' using errcode = 'P0001';
  end if;
  if p_is_active is null then raise exception 'VALIDATION: active flag is required' using errcode = 'P0001'; end if;

  select * into v_old from catalog.price_lists where id = p_price_list_id for update;
  v_created := not found;

  if exists (select 1 from catalog.price_lists where upper(code) = v_code and id <> p_price_list_id) then
    raise exception 'DUPLICATE_CODE: price list code % is already used', v_code using errcode = 'P0001';
  end if;
  if not v_created and v_old.kind <> p_kind then
    raise exception 'VALIDATION: the kind of a price list cannot change' using errcode = 'P0001';
  end if;
  if (not v_created and v_old.code = 'DEFAULT' and v_code <> 'DEFAULT')
     or (v_code = 'DEFAULT' and (p_kind <> 'standard' or not p_is_active or p_valid_to is not null)) then
    raise exception 'DEFAULT_LIST_PROTECTED: the DEFAULT list must stay standard, active and open-ended'
      using errcode = 'P0001';
  end if;

  begin
    if v_created then
      insert into catalog.price_lists (id, code, name, kind, currency, priority, valid_from, valid_to, is_active)
      values (p_price_list_id, v_code, v_name, p_kind, 'EGP', p_priority, p_valid_from, p_valid_to, p_is_active)
      returning * into v_new;
    else
      update catalog.price_lists set code = v_code, name = v_name, priority = p_priority,
             valid_from = p_valid_from, valid_to = p_valid_to, is_active = p_is_active
      where id = p_price_list_id
      returning * into v_new;
    end if;
  exception when unique_violation then
    raise exception 'DUPLICATE_CODE: price list code % is already used', v_code using errcode = 'P0001';
  end;

  if v_created or (v_new.code, v_new.name, v_new.priority, v_new.valid_from, v_new.valid_to, v_new.is_active)
                   is distinct from (v_old.code, v_old.name, v_old.priority, v_old.valid_from, v_old.valid_to, v_old.is_active) then
    perform catalog._emit('price_list.updated', 'catalog.price_list', p_price_list_id,
      jsonb_build_object('price_list_id', p_price_list_id, 'code', v_new.code, 'kind', v_new.kind,
                         'priority', v_new.priority, 'valid_from', v_new.valid_from, 'valid_to', v_new.valid_to,
                         'is_active', v_new.is_active, 'created', v_created));
  end if;

  return jsonb_build_object('price_list_id', p_price_list_id, 'code', v_new.code, 'kind', v_new.kind,
                            'is_active', v_new.is_active, 'created', v_created);
end $$;

-- Set (insert or change) the unit price of a variant for a quantity tier on a list.
create or replace function api.set_price_list_item(p_price_list_id uuid, p_variant_id uuid, p_unit_price numeric,
                                                   p_min_qty int default 1)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_price numeric;
  v_list catalog.price_lists%rowtype;
  v_variant catalog.product_variants%rowtype;
  v_previous numeric;
begin
  perform catalog._require_global('catalog.price.manage');
  v_price := catalog._check_price(p_unit_price);
  if p_min_qty is null or p_min_qty < 1 or p_min_qty > 100000 then
    raise exception 'VALIDATION: minimum quantity must be between 1 and 100000' using errcode = 'P0001';
  end if;
  select * into v_list from catalog.price_lists where id = p_price_list_id for update;
  if not found then raise exception 'NOT_FOUND: price list' using errcode = 'P0002'; end if;
  select * into v_variant from catalog.product_variants where id = p_variant_id;
  if not found then raise exception 'NOT_FOUND: variant' using errcode = 'P0002'; end if;
  if v_variant.status = 'discontinued' then
    raise exception 'INVALID_STATE: variant % is discontinued', v_variant.sku using errcode = 'P0001';
  end if;

  select unit_price into v_previous from catalog.price_list_items
  where price_list_id = p_price_list_id and variant_id = p_variant_id and min_qty = p_min_qty for update;

  if v_previous is not distinct from v_price then
    return jsonb_build_object('price_list_id', p_price_list_id, 'variant_id', p_variant_id, 'min_qty', p_min_qty,
                              'unit_price', v_price, 'previous_unit_price', v_previous, 'changed', false);
  end if;

  insert into catalog.price_list_items (price_list_id, variant_id, unit_price, min_qty)
  values (p_price_list_id, p_variant_id, v_price, p_min_qty)
  on conflict (price_list_id, variant_id, min_qty) do update set unit_price = excluded.unit_price;

  perform catalog._emit('price.changed', 'catalog.price_list', p_price_list_id,
    jsonb_build_object('price_list_id', p_price_list_id, 'price_list_code', v_list.code, 'kind', v_list.kind,
                       'variant_id', p_variant_id, 'sku', v_variant.sku, 'min_qty', p_min_qty,
                       'unit_price', v_price, 'previous_unit_price', v_previous, 'currency', 'EGP'));
  return jsonb_build_object('price_list_id', p_price_list_id, 'variant_id', p_variant_id, 'min_qty', p_min_qty,
                            'unit_price', v_price, 'previous_unit_price', v_previous, 'changed', true);
end $$;

-- Remove a quantity tier. Orders keep their own price snapshot; the audit log keeps the row.
create or replace function api.remove_price_list_item(p_price_list_id uuid, p_variant_id uuid, p_min_qty int default 1)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_previous numeric; v_list_code text; v_sku text;
begin
  perform catalog._require_global('catalog.price.manage');
  delete from catalog.price_list_items
  where price_list_id = p_price_list_id and variant_id = p_variant_id and min_qty = p_min_qty
  returning unit_price into v_previous;
  if not found then raise exception 'NOT_FOUND: price list item' using errcode = 'P0002'; end if;
  select code into v_list_code from catalog.price_lists where id = p_price_list_id;
  select sku into v_sku from catalog.product_variants where id = p_variant_id;
  perform catalog._emit('price.changed', 'catalog.price_list', p_price_list_id,
    jsonb_build_object('price_list_id', p_price_list_id, 'price_list_code', v_list_code, 'variant_id', p_variant_id,
                       'sku', v_sku, 'min_qty', p_min_qty, 'unit_price', null,
                       'previous_unit_price', v_previous, 'removed', true, 'currency', 'EGP'));
  return jsonb_build_object('price_list_id', p_price_list_id, 'variant_id', p_variant_id, 'min_qty', p_min_qty,
                            'previous_unit_price', v_previous, 'removed', true);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Customer price lists
-- ---------------------------------------------------------------------------
create or replace function api.assign_customer_price_list(p_customer_id uuid, p_price_list_id uuid,
                                                          p_valid_from date default current_date,
                                                          p_valid_to date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cust crm.customers%rowtype; v_kind text; v_replayed boolean := false;
begin
  perform catalog._require_global('catalog.price.manage');
  select * into v_cust from crm.customers where id = p_customer_id;
  if not found then raise exception 'NOT_FOUND: customer' using errcode = 'P0002'; end if;
  if not authz.customer_in_scope('crm.customer.read', p_customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  if v_cust.archived_at is not null then
    raise exception 'INVALID_STATE: customer is archived' using errcode = 'P0001';
  end if;
  select kind into v_kind from catalog.price_lists where id = p_price_list_id;
  if not found then raise exception 'NOT_FOUND: price list' using errcode = 'P0002'; end if;
  if v_kind <> 'customer' then
    raise exception 'VALIDATION: only customer price lists can be assigned to a customer' using errcode = 'P0001';
  end if;
  if p_valid_from is null then raise exception 'VALIDATION: valid from is required' using errcode = 'P0001'; end if;
  if p_valid_to is not null and p_valid_to < p_valid_from then
    raise exception 'VALIDATION: valid to must be on or after valid from' using errcode = 'P0001';
  end if;

  -- Same assignment again (same start date) = idempotent replay / end-date change.
  if exists (select 1 from catalog.customer_price_lists
             where customer_id = p_customer_id and price_list_id = p_price_list_id and valid_from = p_valid_from) then
    v_replayed := true;
  end if;
  if exists (select 1 from catalog.customer_price_lists
             where customer_id = p_customer_id and price_list_id = p_price_list_id and valid_from <> p_valid_from
               and daterange(valid_from, valid_to, '[]') && daterange(p_valid_from, p_valid_to, '[]')) then
    raise exception 'OVERLAP: this customer already has this price list for part of that period' using errcode = 'P0001';
  end if;

  insert into catalog.customer_price_lists (customer_id, price_list_id, valid_from, valid_to)
  values (p_customer_id, p_price_list_id, p_valid_from, p_valid_to)
  on conflict (customer_id, price_list_id, valid_from) do update set valid_to = excluded.valid_to;

  return jsonb_build_object('customer_id', p_customer_id, 'price_list_id', p_price_list_id,
                            'valid_from', p_valid_from, 'valid_to', p_valid_to, 'replayed', v_replayed);
end $$;

-- End an assignment: it applies up to and including p_end_on. An assignment that has
-- not started yet is cancelled (valid_to = valid_from - 1, never effective). No back-dating.
create or replace function api.end_customer_price_list(p_customer_id uuid, p_price_list_id uuid, p_valid_from date,
                                                       p_end_on date default current_date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row catalog.customer_price_lists%rowtype; v_to date;
begin
  perform catalog._require_global('catalog.price.manage');
  if not authz.customer_in_scope('crm.customer.read', p_customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  if p_end_on is null or p_end_on < current_date then
    raise exception 'VALIDATION: the end date cannot be in the past' using errcode = 'P0001';
  end if;
  select * into v_row from catalog.customer_price_lists
  where customer_id = p_customer_id and price_list_id = p_price_list_id and valid_from = p_valid_from for update;
  if not found then raise exception 'NOT_FOUND: customer price list' using errcode = 'P0002'; end if;
  if v_row.valid_to is not null and v_row.valid_to <= p_end_on then
    raise exception 'INVALID_STATE: this assignment already ends on %', v_row.valid_to using errcode = 'P0001';
  end if;
  v_to := case when p_end_on < v_row.valid_from then v_row.valid_from - 1 else p_end_on end;
  update catalog.customer_price_lists set valid_to = v_to
  where customer_id = p_customer_id and price_list_id = p_price_list_id and valid_from = p_valid_from;
  return jsonb_build_object('customer_id', p_customer_id, 'price_list_id', p_price_list_id,
                            'valid_from', p_valid_from, 'valid_to', v_to, 'cancelled', v_to < v_row.valid_from);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Promotions (sales.discount_rules). Created and ended, never edited: what applied
--    when is always clear. sales.price_order applies the best active promotion at save/submit.
-- ---------------------------------------------------------------------------
create or replace function api.create_promotion(
  p_promotion_id uuid,
  p_name         text,
  p_discount_pct numeric,
  p_valid_from   date,
  p_valid_to     date default null,
  p_brand_id     uuid default null,
  p_category_id  uuid default null,
  p_variant_id   uuid default null,
  p_customer_id  uuid default null,
  p_min_qty      int default 1,
  p_priority     int default 100)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_name text := nullif(btrim(p_name), '');
  v_variant record;
begin
  perform catalog._require_global('catalog.price.manage');
  if p_promotion_id is null then raise exception 'VALIDATION: promotion id is required' using errcode = 'P0001'; end if;

  -- Idempotent replay: the same id returns the stored promotion unchanged.
  if exists (select 1 from sales.discount_rules where id = p_promotion_id) then
    return (select jsonb_build_object('promotion_id', d.id, 'name', d.name, 'discount_pct', d.discount_pct,
                                      'replayed', true)
            from sales.discount_rules d where d.id = p_promotion_id);
  end if;

  if v_name is null or length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'VALIDATION: promotion name must be 2-120 characters' using errcode = 'P0001';
  end if;
  if p_discount_pct is null or p_discount_pct <= 0 or p_discount_pct > 100 or p_discount_pct <> round(p_discount_pct, 2) then
    raise exception 'VALIDATION: discount must be above 0 and at most 100 percent, with at most 2 decimals'
      using errcode = 'P0001';
  end if;
  if p_valid_from is null then raise exception 'VALIDATION: valid from is required' using errcode = 'P0001'; end if;
  if p_valid_to is not null and p_valid_to < p_valid_from then
    raise exception 'VALIDATION: valid to must be on or after valid from' using errcode = 'P0001';
  end if;
  if p_valid_to is not null and p_valid_to < current_date then
    raise exception 'VALIDATION: a new promotion cannot end in the past' using errcode = 'P0001';
  end if;
  if p_min_qty is null or p_min_qty < 1 or p_min_qty > 100000 then
    raise exception 'VALIDATION: minimum quantity must be between 1 and 100000' using errcode = 'P0001';
  end if;
  if p_priority is null or p_priority < 1 or p_priority > 1000 then
    raise exception 'VALIDATION: priority must be between 1 and 1000' using errcode = 'P0001';
  end if;
  if p_brand_id is not null and not exists (select 1 from catalog.brands where id = p_brand_id) then
    raise exception 'VALIDATION: unknown brand' using errcode = 'P0001';
  end if;
  if p_category_id is not null and not exists (select 1 from catalog.categories where id = p_category_id) then
    raise exception 'VALIDATION: unknown category' using errcode = 'P0001';
  end if;
  if p_variant_id is not null then
    select pv.id, p.brand_id, p.category_id into v_variant
    from catalog.product_variants pv join catalog.products p on p.id = pv.product_id where pv.id = p_variant_id;
    if not found then raise exception 'VALIDATION: unknown variant' using errcode = 'P0001'; end if;
    if (p_brand_id is not null and p_brand_id <> v_variant.brand_id)
       or (p_category_id is not null and p_category_id <> v_variant.category_id) then
      raise exception 'VALIDATION: the variant does not belong to that brand or category' using errcode = 'P0001';
    end if;
  end if;
  if p_customer_id is not null then
    if not exists (select 1 from crm.customers where id = p_customer_id) then
      raise exception 'NOT_FOUND: customer' using errcode = 'P0002';
    end if;
    if not authz.customer_in_scope('crm.customer.read', p_customer_id) then
      raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
    end if;
  end if;

  insert into sales.discount_rules (id, name, brand_id, category_id, variant_id, customer_id, discount_pct,
                                    min_qty, valid_from, valid_to, priority, is_active)
  values (p_promotion_id, v_name, p_brand_id, p_category_id, p_variant_id, p_customer_id, p_discount_pct,
          p_min_qty, p_valid_from, p_valid_to, p_priority, true);

  perform catalog._emit('promotion.created', 'sales.promotion', p_promotion_id,
    jsonb_build_object('promotion_id', p_promotion_id, 'name', v_name, 'discount_pct', p_discount_pct,
                       'brand_id', p_brand_id, 'category_id', p_category_id, 'variant_id', p_variant_id,
                       'customer_id', p_customer_id, 'min_qty', p_min_qty,
                       'valid_from', p_valid_from, 'valid_to', p_valid_to));
  return jsonb_build_object('promotion_id', p_promotion_id, 'name', v_name, 'discount_pct', p_discount_pct,
                            'replayed', false);
end $$;

-- Stop a promotion now. Orders already saved keep the discount they were priced with;
-- drafts lose it when they are submitted (re-priced).
create or replace function api.end_promotion(p_promotion_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row sales.discount_rules%rowtype; v_to date;
begin
  perform catalog._require_global('catalog.price.manage');
  select * into v_row from sales.discount_rules where id = p_promotion_id for update;
  if not found then raise exception 'NOT_FOUND: promotion' using errcode = 'P0002'; end if;
  if v_row.customer_id is not null and not authz.customer_in_scope('crm.customer.read', v_row.customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  if not v_row.is_active or v_row.valid_to < current_date then
    raise exception 'INVALID_STATE: promotion has already ended' using errcode = 'P0001';
  end if;
  v_to := case when v_row.valid_from <= current_date then least(coalesce(v_row.valid_to, current_date), current_date)
               else v_row.valid_to end;
  update sales.discount_rules set is_active = false, valid_to = v_to where id = p_promotion_id;
  perform catalog._emit('promotion.ended', 'sales.promotion', p_promotion_id,
    jsonb_build_object('promotion_id', p_promotion_id, 'name', v_row.name, 'ended_on', current_date));
  return jsonb_build_object('promotion_id', p_promotion_id, 'is_active', false, 'valid_to', v_to);
end $$;

-- ---------------------------------------------------------------------------
-- 8. Read views (security_invoker → the caller's RLS applies; no cost anywhere)
-- ---------------------------------------------------------------------------
create or replace view api.v_catalog_brands with (security_invoker = true) as
  select b.id, b.code, b.name, b.country_of_origin, b.is_active from catalog.brands b;

create or replace view api.v_catalog_categories with (security_invoker = true) as
  select c.id, c.code, c.name_en, c.name_ar, c.parent_id from catalog.categories c;

create or replace view api.v_catalog_products with (security_invoker = true) as
  select p.id, p.code, p.name_en, p.name_ar, p.description, p.status,
         p.brand_id, b.code as brand_code, b.name as brand_name,
         p.category_id, c.code as category_code, c.name_en as category_name_en, c.name_ar as category_name_ar,
         p.is_lot_tracked, p.is_expiry_tracked, p.is_serial_tracked, p.tax_rate_pct,
         coalesce(vc.variant_count, 0)::int as variant_count,
         coalesce(vc.active_variant_count, 0)::int as active_variant_count,
         p.created_at, p.updated_at
  from catalog.products p
  join catalog.brands b on b.id = p.brand_id
  join catalog.categories c on c.id = p.category_id
  left join lateral (select count(*) as variant_count, count(*) filter (where v.status = 'active') as active_variant_count
                     from catalog.product_variants v where v.product_id = p.id) vc on true;

-- default_price: the DEFAULT list's single-unit price (NULL without catalog.price.read).
create or replace view api.v_catalog_variants with (security_invoker = true) as
  select v.id, v.product_id, p.code as product_code, p.name_en as product_name_en, p.name_ar as product_name_ar,
         p.status as product_status, p.brand_id, b.code as brand_code, b.name as brand_name,
         v.sku, v.name_en, v.attributes, v.barcode, v.uom, v.reorder_point, v.status,
         (v.status = 'active' and p.status = 'active') as is_sellable,
         dp.unit_price as default_price, v.created_at
  from catalog.product_variants v
  join catalog.products p on p.id = v.product_id
  join catalog.brands b on b.id = p.brand_id
  left join lateral (select pli.unit_price from catalog.price_list_items pli
                     join catalog.price_lists pl on pl.id = pli.price_list_id
                     where pl.code = 'DEFAULT' and pli.variant_id = v.id and pli.min_qty = 1) dp on true;

create or replace view api.v_price_lists with (security_invoker = true) as
  select pl.id, pl.code, pl.name, pl.kind, pl.currency, pl.priority, pl.valid_from, pl.valid_to, pl.is_active,
         (pl.is_active and current_date >= pl.valid_from and (pl.valid_to is null or current_date <= pl.valid_to)) as is_current,
         (pl.code = 'DEFAULT') as is_default,
         (select count(*) from catalog.price_list_items pli where pli.price_list_id = pl.id)::int as item_count,
         (select count(*) from catalog.customer_price_lists cpl
          where cpl.price_list_id = pl.id and (cpl.valid_to is null or cpl.valid_to >= current_date)
            and cpl.valid_to is distinct from cpl.valid_from - 1)::int as customer_count
  from catalog.price_lists pl;

create or replace view api.v_price_list_items with (security_invoker = true) as
  select pli.price_list_id, pl.code as price_list_code, pli.variant_id, v.sku, v.name_en as variant_name_en,
         v.status as variant_status, v.product_id, p.code as product_code, p.name_en as product_name_en,
         p.name_ar as product_name_ar, p.status as product_status, pli.min_qty, pli.unit_price
  from catalog.price_list_items pli
  join catalog.price_lists pl on pl.id = pli.price_list_id
  join catalog.product_variants v on v.id = pli.variant_id
  join catalog.products p on p.id = v.product_id;

-- state: current | scheduled | ended | cancelled (ended before it started).
create or replace view api.v_customer_price_lists with (security_invoker = true) as
  select cpl.customer_id, c.customer_no, c.display_name as customer_name,
         cpl.price_list_id, pl.code as price_list_code, pl.name as price_list_name,
         cpl.valid_from, cpl.valid_to,
         case when cpl.valid_to is not null and cpl.valid_to < cpl.valid_from then 'cancelled'
              when cpl.valid_to is not null and cpl.valid_to < current_date then 'ended'
              when cpl.valid_from > current_date then 'scheduled'
              else 'current' end as state
  from catalog.customer_price_lists cpl
  join crm.customers c on c.id = cpl.customer_id
  join catalog.price_lists pl on pl.id = cpl.price_list_id;

-- state: active | scheduled | ended.
create or replace view api.v_promotions with (security_invoker = true) as
  select d.id, d.name, d.discount_pct, d.min_qty, d.valid_from, d.valid_to, d.priority, d.is_active,
         d.brand_id, b.code as brand_code, b.name as brand_name,
         d.category_id, c.code as category_code, c.name_en as category_name_en, c.name_ar as category_name_ar,
         d.variant_id, v.sku as variant_sku, v.name_en as variant_name_en,
         d.customer_id, cu.customer_no, cu.display_name as customer_name,
         case when not d.is_active or d.valid_to < current_date then 'ended'
              when d.valid_from > current_date then 'scheduled'
              else 'active' end as state
  from sales.discount_rules d
  left join catalog.brands b on b.id = d.brand_id
  left join catalog.categories c on c.id = d.category_id
  left join catalog.product_variants v on v.id = d.variant_id
  left join crm.customers cu on cu.id = d.customer_id;

-- ---------------------------------------------------------------------------
-- 9. Privileges. Grants are explicit per object: a blanket "grant execute on all
--    functions in schema api" would re-open functions an earlier migration closed
--    (e.g. api.post_inventory_adjustment, audit fix #11).
-- ---------------------------------------------------------------------------
grant select on api.v_catalog_brands, api.v_catalog_categories, api.v_catalog_products, api.v_catalog_variants,
                api.v_price_lists, api.v_price_list_items, api.v_customer_price_lists, api.v_promotions
  to authenticated;
revoke all on api.v_catalog_brands, api.v_catalog_categories, api.v_catalog_products, api.v_catalog_variants,
              api.v_price_lists, api.v_price_list_items, api.v_customer_price_lists, api.v_promotions
  from anon;

do $$
declare f text;
begin
  foreach f in array array[
    'api.upsert_product(uuid, uuid, uuid, text, text, text, text, boolean, boolean, boolean, text)',
    'api.set_product_status(uuid, text)',
    'api.upsert_variant(uuid, uuid, text, text, jsonb, text, text, int)',
    'api.set_variant_status(uuid, text)',
    'api.upsert_price_list(uuid, text, text, text, int, date, date, boolean)',
    'api.set_price_list_item(uuid, uuid, numeric, int)',
    'api.remove_price_list_item(uuid, uuid, int)',
    'api.assign_customer_price_list(uuid, uuid, date, date)',
    'api.end_customer_price_list(uuid, uuid, date, date)',
    'api.create_promotion(uuid, text, numeric, date, date, uuid, uuid, uuid, uuid, int, int)',
    'api.end_promotion(uuid)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- Internal helpers are never callable by app users.
revoke execute on function catalog._require_global(text) from public, anon, authenticated;
revoke execute on function catalog._emit(text, text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function catalog._check_price(numeric) from public, anon, authenticated;
revoke execute on function catalog._clean_code(text, text) from public, anon, authenticated;
