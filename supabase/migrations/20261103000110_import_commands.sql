-- Honest OS migration: data migration commands (ROADMAP Phase 3 task 11, docs/DATABASE.md §7).
--
-- Flow: the app parses a CSV (UTF-8) on the server and stages it with
--   api.import_create_batch(kind, rows, idempotency_key, file_name)   → status 'uploaded'
--   api.import_validate(batch)    → per-row errors (the rejects report); 'validated' or 'failed'
--   api.import_commit(batch)      → re-validates, then posts every row in ONE transaction
--   api.import_discard(batch)     → abandons a batch that was not committed (rows deleted)
-- Reads: api.v_import_batches, api.v_import_rows (security_invoker).
--
-- Kinds and how they post (the same commands and ledgers as normal documents, so every rule,
-- audit row and outbox event applies):
--   customers        api.create_customer (source 'import', client_ref = staging row id)
--   products         api.upsert_product + api.upsert_variant
--   customer_prices  api.upsert_price_list (kind 'customer') + api.set_price_list_item
--                    + api.assign_customer_price_list
--   opening_stock    api.create_goods_receipt + api.post_goods_receipt per warehouse
--                    → 'receipt' movements per lot; balances maintained by the ledger trigger
--   opening_ar       one 'opening_balance' entry per customer in finance.customer_ledger
--                    (entry type allowed since 20261028000800; no CHECK change needed)
--
-- Authorization: every command needs admin.import.run at scope 'all' (owner by default) AND
-- the permission of the kind's own command at scope 'all' (crm.customer.create,
-- catalog.product.manage, catalog.price.manage, inventory.receipt.post; opening_ar has no
-- separate command and is guarded by admin.import.run alone).
--
-- All-or-nothing: api.import_commit runs the posting inside one subtransaction. Any failure
-- rolls back every row it posted and is recorded on the batch (status 'failed', failure,
-- failure_row_no); the function then returns normally so that record survives.
-- A committed batch can never be committed (or discarded) again.
--
-- D-03: synthetic data only until the PDPL legal review clears real personal data.

-- ---------------------------------------------------------------------------
-- 1. Small parsing helpers (internal; not client-callable)
-- ---------------------------------------------------------------------------
create or replace function import._t(p_raw jsonb, p_key text) returns text
language sql immutable set search_path = '' as $$
  select nullif(btrim(p_raw ->> p_key), '')
$$;

create or replace function import._int(p text) returns bigint
language sql immutable set search_path = '' as $$
  select case when p ~ '^[+-]?[0-9]{1,12}$' then p::bigint end
$$;

-- Plain decimal with at most 2 decimals, no thousands separators.
create or replace function import._num(p text) returns numeric
language sql immutable set search_path = '' as $$
  select case when p ~ '^[+-]?[0-9]{1,12}(\.[0-9]{1,2})?$' then p::numeric end
$$;

create or replace function import._date(p text) returns date
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return null; end if;
  return p::date;
exception when others then
  return null;
end $$;

create or replace function import._bool(p text) returns boolean
language sql immutable set search_path = '' as $$
  select case when lower(p) in ('yes','y','true','1','نعم') then true
              when lower(p) in ('no','n','false','0','لا') then false end
$$;

create or replace function import._phone(p text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  return core.to_phone_e164(p, 'phone')::text;
exception when others then
  return null;
end $$;

-- Columns each kind accepts, and those that must be present as headers.
create or replace function import._columns(p_kind text) returns text[]
language sql immutable set search_path = '' as $$
  select case p_kind
    when 'customers' then array['doctor_name','clinic_name','display_name','kind','specialty_code','phone_primary',
                                'phone_secondary','email','governorate_code','city','address_line','territory_code',
                                'rep_employee_no','notes']
    when 'products' then array['product_code','brand_code','category_code','product_name_en','product_name_ar',
                               'lot_tracked','expiry_tracked','sku','variant_name_en','barcode','uom','reorder_point']
    when 'customer_prices' then array['customer_no','customer_phone','price_list_code','price_list_name','sku',
                                      'unit_price','min_qty','valid_from']
    when 'opening_stock' then array['warehouse_code','sku','lot_no','expiry_date','quantity','unit_cost']
    when 'opening_ar' then array['customer_no','customer_phone','amount']
  end
$$;

create or replace function import._required_columns(p_kind text) returns text[]
language sql immutable set search_path = '' as $$
  select case p_kind
    when 'customers' then array['phone_primary','governorate_code']
    when 'products' then array['product_code','sku','variant_name_en']
    when 'customer_prices' then array['price_list_code','sku','unit_price']
    when 'opening_stock' then array['warehouse_code','sku','quantity']
    when 'opening_ar' then array['amount']
  end
$$;

-- The command each kind posts through; its permission is required at scope 'all'.
create or replace function import._kind_permission(p_kind text) returns text
language sql immutable set search_path = '' as $$
  select case p_kind
    when 'customers' then 'crm.customer.create'
    when 'products' then 'catalog.product.manage'
    when 'customer_prices' then 'catalog.price.manage'
    when 'opening_stock' then 'inventory.receipt.post'
    else null
  end
$$;

create or replace function import._require(p_kind text) returns void
language plpgsql stable set search_path = '' as $$
declare v_perm text := import._kind_permission(p_kind);
begin
  perform authz.require('admin.import.run');
  if not authz.has_global('admin.import.run') then
    raise exception 'PERMISSION_DENIED: admin.import.run needs company-wide scope' using errcode = '42501';
  end if;
  if v_perm is not null and not authz.has_global(v_perm) then
    raise exception 'PERMISSION_DENIED: importing % needs % at company-wide scope', p_kind, v_perm using errcode = '42501';
  end if;
end $$;

-- A customer named by customer_no and/or phone (both, when given, must agree).
create or replace function import._customer(p_no text, p_phone text, out customer_id uuid, out error text)
language plpgsql stable set search_path = '' as $$
declare v_by_no uuid; v_by_phone uuid; v_phone text; v_archived timestamptz;
begin
  if p_no is null and p_phone is null then error := 'required:customer'; return; end if;
  if p_no is not null then
    select c.id into v_by_no from crm.customers c where upper(c.customer_no) = upper(p_no);
    if v_by_no is null then error := 'unknown:customer_no'; return; end if;
  end if;
  if p_phone is not null then
    v_phone := import._phone(p_phone);
    if v_phone is null then error := 'invalid:customer_phone'; return; end if;
    select c.id into v_by_phone from crm.customers c where c.phone_primary = v_phone and c.archived_at is null;
    if v_by_phone is null then error := 'unknown:customer_phone'; return; end if;
  end if;
  if v_by_no is not null and v_by_phone is not null and v_by_no <> v_by_phone then
    error := 'mismatch:customer_phone'; return;
  end if;
  customer_id := coalesce(v_by_no, v_by_phone);
  select c.archived_at into v_archived from crm.customers c where c.id = customer_id;
  if v_archived is not null then customer_id := null; error := 'inactive:customer'; end if;
end $$;

-- Append an error to every row of the batch whose key (an expression over normalized)
-- occurs on more than one row. p_key_sql is a fixed expression from this file, never input.
create or replace function import._flag_duplicates(p_batch uuid, p_key_sql text, p_error text, p_having text default 'count(*) > 1')
returns void language plpgsql set search_path = '' as $$
begin
  execute format(
    'update import.rows x set errors = array_append(x.errors, %L)
     where x.batch_id = $1 and (%s) is not null and (%s) in (
       select (%s) from import.rows r where r.batch_id = $1 and (%s) is not null group by 1 having %s)',
    p_error, replace(p_key_sql, '$r', 'x'), replace(p_key_sql, '$r', 'x'),
    replace(p_key_sql, '$r', 'r'), replace(p_key_sql, '$r', 'r'), p_having)
  using p_batch;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Validation per kind. Each writes normalized + errors on every row of the batch.
-- ---------------------------------------------------------------------------
create or replace function import._validate_customers(p_batch uuid) returns void
language plpgsql set search_path = '' as $$
declare
  r record; e text[]; v text;
  v_doctor text; v_clinic text; v_display text; v_phone text; v_phone2 text; v_email text;
  v_gov text; v_kind text; v_spec text; v_terr uuid; v_emp uuid;
begin
  for r in select id, raw from import.rows where batch_id = p_batch order by row_no loop
    e := '{}';
    v_doctor := import._t(r.raw, 'doctor_name');
    v_clinic := import._t(r.raw, 'clinic_name');
    v_display := import._t(r.raw, 'display_name');
    if v_doctor is null and v_clinic is null then e := array_append(e, 'required:doctor_name/clinic_name'); end if;
    if length(v_doctor) > 160 then e := array_append(e, 'invalid:doctor_name'); end if;
    if length(v_clinic) > 160 then e := array_append(e, 'invalid:clinic_name'); end if;
    if length(v_display) > 200 then e := array_append(e, 'invalid:display_name'); end if;

    v := import._t(r.raw, 'phone_primary');
    v_phone := import._phone(v);
    if v is null then e := array_append(e, 'required:phone_primary');
    elsif v_phone is null then e := array_append(e, 'invalid:phone_primary');
    elsif exists (select 1 from crm.customers c where c.phone_primary = v_phone and c.archived_at is null) then
      e := array_append(e, 'exists:phone_primary');
    end if;
    v := import._t(r.raw, 'phone_secondary');
    v_phone2 := import._phone(v);
    if v is not null and v_phone2 is null then e := array_append(e, 'invalid:phone_secondary'); end if;

    v_email := import._t(r.raw, 'email');
    if v_email is not null and (v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(v_email) > 200) then
      e := array_append(e, 'invalid:email');
    end if;

    v_gov := upper(import._t(r.raw, 'governorate_code'));
    if v_gov is null then e := array_append(e, 'required:governorate_code');
    elsif not exists (select 1 from core.governorates g where g.code = v_gov) then e := array_append(e, 'unknown:governorate_code');
    end if;

    v_kind := lower(coalesce(import._t(r.raw, 'kind'), 'clinic'));
    if v_kind not in ('clinic','doctor','hospital','university','lab','distributor') then e := array_append(e, 'invalid:kind'); end if;

    v_spec := upper(import._t(r.raw, 'specialty_code'));
    if v_spec is not null and not exists (select 1 from crm.specialties s where s.code = v_spec) then
      e := array_append(e, 'unknown:specialty_code');
    end if;

    v_terr := null;
    v := import._t(r.raw, 'territory_code');
    if v is not null then
      select t.id into v_terr from core.territories t where upper(t.code) = upper(v) and t.is_active;
      if v_terr is null then e := array_append(e, 'unknown:territory_code'); end if;
    end if;

    v_emp := null;
    v := import._t(r.raw, 'rep_employee_no');
    if v is not null then
      select em.id into v_emp from core.employees em where upper(em.employee_no) = upper(v) and em.employment_status = 'active';
      if v_emp is null then e := array_append(e, 'unknown:rep_employee_no'); end if;
    end if;

    if length(import._t(r.raw, 'city')) > 100 then e := array_append(e, 'invalid:city'); end if;
    if length(import._t(r.raw, 'address_line')) > 300 then e := array_append(e, 'invalid:address_line'); end if;
    if length(import._t(r.raw, 'notes')) > 2000 then e := array_append(e, 'invalid:notes'); end if;

    update import.rows set errors = e, normalized = jsonb_strip_nulls(jsonb_build_object(
      'doctor_name', v_doctor, 'clinic_name', v_clinic, 'display_name', v_display, 'kind', v_kind,
      'specialty_code', v_spec, 'phone_primary', v_phone, 'phone_secondary', v_phone2, 'email', v_email,
      'governorate_code', v_gov, 'city', import._t(r.raw, 'city'), 'address_line', import._t(r.raw, 'address_line'),
      'territory_id', v_terr, 'owner_employee_id', v_emp, 'notes', import._t(r.raw, 'notes')))
    where id = r.id;
  end loop;

  perform import._flag_duplicates(p_batch, '$r.normalized ->> ''phone_primary''', 'duplicate_in_file:phone_primary');
end $$;

create or replace function import._validate_products(p_batch uuid) returns void
language plpgsql set search_path = '' as $$
declare
  r record; e text[]; v text; p catalog.products%rowtype;
  v_code text; v_new boolean; v_brand uuid; v_cat uuid; v_name text; v_name_ar text; v_lot boolean; v_exp boolean;
  v_sku text; v_vname text; v_barcode text; v_uom text; v_reorder bigint;
begin
  for r in select id, raw from import.rows where batch_id = p_batch order by row_no loop
    e := '{}'; v_new := null; v_brand := null; v_cat := null; v_lot := null; v_exp := null; p := null;
    v_name := import._t(r.raw, 'product_name_en');
    v_name_ar := import._t(r.raw, 'product_name_ar');

    v_code := upper(import._t(r.raw, 'product_code'));
    if v_code is null then e := array_append(e, 'required:product_code');
    elsif v_code !~ '^[A-Z0-9][A-Z0-9._-]{1,39}$' then e := array_append(e, 'invalid:product_code');
    else
      select * into p from catalog.products cp where upper(cp.code) = v_code;
      v_new := p.id is null;
      if not v_new and p.status = 'discontinued' then e := array_append(e, 'discontinued:product_code'); end if;
    end if;

    -- Product columns matter only for a product that does not exist yet (existing ones are reused as-is).
    if v_new is distinct from false then
      v := import._t(r.raw, 'brand_code');
      if v is null then e := array_append(e, 'required:brand_code');
      else
        select b.id into v_brand from catalog.brands b where upper(b.code) = upper(v) and b.is_active;
        if v_brand is null then e := array_append(e, 'unknown:brand_code'); end if;
      end if;
      v := import._t(r.raw, 'category_code');
      if v is null then e := array_append(e, 'required:category_code');
      else
        select c.id into v_cat from catalog.categories c where upper(c.code) = upper(v);
        if v_cat is null then e := array_append(e, 'unknown:category_code'); end if;
      end if;
      if v_name is null then e := array_append(e, 'required:product_name_en');
      elsif length(v_name) < 2 or length(v_name) > 160 then e := array_append(e, 'invalid:product_name_en');
      end if;
      if length(v_name_ar) > 160 then e := array_append(e, 'invalid:product_name_ar'); end if;
      v := import._t(r.raw, 'lot_tracked');
      v_lot := coalesce(import._bool(v), case when v is null then true end);
      if v_lot is null then e := array_append(e, 'invalid:lot_tracked'); end if;
      v := import._t(r.raw, 'expiry_tracked');
      v_exp := coalesce(import._bool(v), case when v is null then false end);
      if v_exp is null then e := array_append(e, 'invalid:expiry_tracked'); end if;
    end if;

    v_sku := upper(import._t(r.raw, 'sku'));
    if v_sku is null then e := array_append(e, 'required:sku');
    elsif v_sku !~ '^[A-Z0-9][A-Z0-9._/-]{1,63}$' then e := array_append(e, 'invalid:sku');
    elsif exists (select 1 from catalog.product_variants pv where upper(pv.sku) = v_sku) then e := array_append(e, 'exists:sku');
    end if;

    v_vname := import._t(r.raw, 'variant_name_en');
    if v_vname is null then e := array_append(e, 'required:variant_name_en');
    elsif length(v_vname) > 160 then e := array_append(e, 'invalid:variant_name_en');
    end if;

    v_barcode := import._t(r.raw, 'barcode');
    if v_barcode is not null then
      if v_barcode !~ '^[0-9A-Za-z-]{4,64}$' then e := array_append(e, 'invalid:barcode');
      elsif exists (select 1 from catalog.product_variants pv where pv.barcode = v_barcode) then e := array_append(e, 'exists:barcode');
      end if;
    end if;

    v_uom := lower(coalesce(import._t(r.raw, 'uom'), 'unit'));
    if v_uom !~ '^[a-z][a-z_]{0,19}$' then e := array_append(e, 'invalid:uom'); end if;

    v := import._t(r.raw, 'reorder_point');
    v_reorder := coalesce(import._int(v), case when v is null then 0 end);
    if v_reorder is null or v_reorder > 1000000 then e := array_append(e, 'invalid:reorder_point');
    elsif v_reorder < 0 then e := array_append(e, 'negative:reorder_point');
    end if;

    update import.rows set errors = e, normalized = jsonb_strip_nulls(jsonb_build_object(
      'product_code', v_code, 'product_id', p.id, 'new_product', v_new, 'brand_id', v_brand, 'category_id', v_cat,
      'product_name_en', case when v_new then v_name end, 'product_name_ar', case when v_new then v_name_ar end,
      'lot_tracked', v_lot, 'expiry_tracked', v_exp, 'sku', v_sku, 'variant_name_en', v_vname,
      'barcode', v_barcode, 'uom', v_uom, 'reorder_point', v_reorder))
    where id = r.id;
  end loop;

  perform import._flag_duplicates(p_batch, '$r.normalized ->> ''sku''', 'duplicate_in_file:sku');
  perform import._flag_duplicates(p_batch, '$r.normalized ->> ''barcode''', 'duplicate_in_file:barcode');
  -- Rows of one new product must describe it identically.
  perform import._flag_duplicates(p_batch,
    'case when ($r.normalized ->> ''new_product'')::boolean then $r.normalized ->> ''product_code'' end',
    'inconsistent:product_code',
    'count(distinct (r.normalized - array[''sku'',''variant_name_en'',''barcode'',''uom'',''reorder_point''])) > 1');
end $$;

create or replace function import._validate_customer_prices(p_batch uuid) returns void
language plpgsql set search_path = '' as $$
declare
  r record; e text[]; v text; c record; l catalog.price_lists%rowtype;
  v_code text; v_name text; v_variant uuid; v_vstatus text; v_price numeric; v_min bigint; v_from date;
begin
  for r in select id, raw from import.rows where batch_id = p_batch order by row_no loop
    e := '{}'; l := null; v_variant := null; v_vstatus := null;
    select * into c from import._customer(import._t(r.raw, 'customer_no'), import._t(r.raw, 'customer_phone'));
    if c.error is not null then e := array_append(e, c.error); end if;

    v_name := import._t(r.raw, 'price_list_name');
    v_code := upper(import._t(r.raw, 'price_list_code'));
    if v_code is null then e := array_append(e, 'required:price_list_code');
    elsif v_code !~ '^[A-Z0-9][A-Z0-9._-]{1,39}$' then e := array_append(e, 'invalid:price_list_code');
    else
      select * into l from catalog.price_lists pl where upper(pl.code) = v_code;
      if l.id is not null and l.kind <> 'customer' then e := array_append(e, 'wrong_kind:price_list_code'); end if;
      -- A new list needs its name on at least one of its rows (checked after the loop).
      if l.id is null and (length(v_name) < 2 or length(v_name) > 120) then
        e := array_append(e, 'invalid:price_list_name');
      end if;
    end if;

    v := upper(import._t(r.raw, 'sku'));
    if v is null then e := array_append(e, 'required:sku');
    else
      select pv.id, pv.status into v_variant, v_vstatus from catalog.product_variants pv where upper(pv.sku) = v;
      if v_variant is null then e := array_append(e, 'unknown:sku');
      elsif v_vstatus = 'discontinued' then e := array_append(e, 'discontinued:sku');
      end if;
    end if;

    v := import._t(r.raw, 'unit_price');
    v_price := import._num(v);
    if v is null then e := array_append(e, 'required:unit_price');
    elsif v_price is null or v_price = 0 or v_price > 999999999999.99 then e := array_append(e, 'invalid:unit_price');
    elsif v_price < 0 then e := array_append(e, 'negative:unit_price');
    end if;

    v := import._t(r.raw, 'min_qty');
    v_min := coalesce(import._int(v), case when v is null then 1 end);
    if v_min is null or v_min < 1 or v_min > 100000 then e := array_append(e, 'invalid:min_qty'); end if;

    v := import._t(r.raw, 'valid_from');
    v_from := coalesce(import._date(v), case when v is null then core.business_date() end);
    if v_from is null then e := array_append(e, 'invalid:valid_from');
    elsif c.customer_id is not null and l.id is not null and exists (
      select 1 from catalog.customer_price_lists cpl
      where cpl.customer_id = c.customer_id and cpl.price_list_id = l.id and cpl.valid_from <> v_from
        and daterange(cpl.valid_from, cpl.valid_to, '[]') && daterange(v_from, null, '[]')) then
      e := array_append(e, 'overlap:valid_from');
    end if;

    update import.rows set errors = e, normalized = jsonb_strip_nulls(jsonb_build_object(
      'customer_id', c.customer_id, 'price_list_code', v_code, 'price_list_id', l.id, 'new_list', l.id is null,
      'price_list_name', case when l.id is null then v_name end, 'variant_id', v_variant, 'sku', upper(import._t(r.raw, 'sku')),
      'unit_price', v_price, 'min_qty', v_min, 'valid_from', v_from))
    where id = r.id;
  end loop;

  -- The same customer, list, SKU and tier twice.
  perform import._flag_duplicates(p_batch,
    '($r.normalized ->> ''customer_id'') || ''|'' || ($r.normalized ->> ''price_list_code'') || ''|'' || ($r.normalized ->> ''sku'') || ''|'' || ($r.normalized ->> ''min_qty'')',
    'duplicate_in_file:sku');
  -- A list holds one price per SKU and tier, whichever customer row repeats it.
  perform import._flag_duplicates(p_batch,
    '($r.normalized ->> ''price_list_code'') || ''|'' || ($r.normalized ->> ''sku'') || ''|'' || ($r.normalized ->> ''min_qty'')',
    'inconsistent:unit_price', 'count(distinct r.normalized ->> ''unit_price'') > 1');
  -- One start date per customer and list.
  perform import._flag_duplicates(p_batch,
    '($r.normalized ->> ''customer_id'') || ''|'' || ($r.normalized ->> ''price_list_code'')',
    'inconsistent:valid_from', 'count(distinct r.normalized ->> ''valid_from'') > 1');
  -- One name per new list, given on at least one of its rows.
  perform import._flag_duplicates(p_batch,
    'case when ($r.normalized ->> ''new_list'')::boolean then $r.normalized ->> ''price_list_code'' end',
    'inconsistent:price_list_name', 'count(distinct r.normalized ->> ''price_list_name'') > 1');
  perform import._flag_duplicates(p_batch,
    'case when ($r.normalized ->> ''new_list'')::boolean then $r.normalized ->> ''price_list_code'' end',
    'required:price_list_name', 'count(r.normalized ->> ''price_list_name'') = 0');
end $$;

create or replace function import._validate_opening_stock(p_batch uuid) returns void
language plpgsql set search_path = '' as $$
declare
  r record; e text[]; v text; w inventory.warehouses%rowtype;
  v_vid uuid; v_vsku text; v_lot_tracked boolean; v_exp_tracked boolean;
  v_lot text; v_exp date; v_lot_exp date; v_qty bigint; v_cost numeric; v_today date := core.business_date();
begin
  for r in select id, raw from import.rows where batch_id = p_batch order by row_no loop
    e := '{}'; w := null; v_vid := null; v_vsku := null; v_lot_tracked := null; v_exp_tracked := null;
    v_exp := null; v_cost := null; v_lot_exp := null;

    v := import._t(r.raw, 'warehouse_code');
    if v is null then e := array_append(e, 'required:warehouse_code');
    else
      select * into w from inventory.warehouses wh where upper(wh.code) = upper(v);
      if w.id is null then e := array_append(e, 'unknown:warehouse_code');
      elsif not w.is_active then e := array_append(e, 'inactive:warehouse_code');
      elsif w.kind = 'transit' then e := array_append(e, 'wrong_kind:warehouse_code');
      end if;
    end if;

    v := upper(import._t(r.raw, 'sku'));
    if v is null then e := array_append(e, 'required:sku');
    else
      select x.id, x.sku, p.is_lot_tracked, p.is_expiry_tracked into v_vid, v_vsku, v_lot_tracked, v_exp_tracked
      from catalog.product_variants x join catalog.products p on p.id = x.product_id where upper(x.sku) = v;
      if v_vid is null then e := array_append(e, 'unknown:sku'); end if;
    end if;

    v_lot := import._t(r.raw, 'lot_no');
    if v_lot is null then
      if coalesce(v_lot_tracked, true) then e := array_append(e, 'required:lot_no'); else v_lot := 'NO-LOT'; end if;
    elsif length(v_lot) > 64 then e := array_append(e, 'invalid:lot_no');
    end if;

    v := import._t(r.raw, 'expiry_date');
    if v is not null then
      v_exp := import._date(v);
      if v_exp is null then e := array_append(e, 'invalid:expiry_date');
      elsif v_exp < v_today and w.kind is distinct from 'quarantine' then e := array_append(e, 'expired:expiry_date');
      end if;
    elsif v_exp_tracked then
      e := array_append(e, 'required:expiry_date');
    end if;
    if v_exp is not null and v_vid is not null and v_lot is not null then
      select l.expiry_date into v_lot_exp from inventory.lots l where l.variant_id = v_vid and l.lot_no = v_lot;
      if v_lot_exp is not null and v_lot_exp <> v_exp then e := array_append(e, 'mismatch:expiry_date'); end if;
    end if;

    v := import._t(r.raw, 'quantity');
    v_qty := import._int(v);
    if v is null then e := array_append(e, 'required:quantity');
    elsif v_qty is null or v_qty = 0 or v_qty > 1000000 then e := array_append(e, 'invalid:quantity');
    elsif v_qty < 0 then e := array_append(e, 'negative:quantity');
    end if;

    v := import._t(r.raw, 'unit_cost');
    if v is not null then
      v_cost := import._num(v);
      if v_cost is null or v_cost > 999999999999.99 then e := array_append(e, 'invalid:unit_cost');
      elsif v_cost < 0 then e := array_append(e, 'negative:unit_cost');
      end if;
    elsif v_vid is not null and not exists (select 1 from catalog.product_costs pc
                                            where pc.variant_id = v_vid and pc.effective_from <= v_today) then
      e := array_append(e, 'required:unit_cost');
    end if;

    -- Opening stock is loaded once per warehouse, SKU and lot.
    if w.id is not null and v_vid is not null and v_lot is not null and exists (
      select 1 from import.rows x join import.batches b on b.id = x.batch_id
      where b.kind = 'opening_stock' and b.status = 'committed' and x.batch_id <> p_batch
        and x.normalized ->> 'warehouse_id' = w.id::text and x.normalized ->> 'variant_id' = v_vid::text
        and x.normalized ->> 'lot_no' = v_lot) then
      e := array_append(e, 'already_imported:lot_no');
    end if;

    update import.rows set errors = e, normalized = jsonb_strip_nulls(jsonb_build_object(
      'warehouse_id', w.id, 'warehouse_code', w.code, 'variant_id', v_vid, 'sku', v_vsku, 'lot_no', v_lot,
      'expiry_date', v_exp, 'quantity', v_qty, 'unit_cost', v_cost))
    where id = r.id;
  end loop;

  perform import._flag_duplicates(p_batch,
    '($r.normalized ->> ''warehouse_id'') || ''|'' || ($r.normalized ->> ''variant_id'') || ''|'' || ($r.normalized ->> ''lot_no'')',
    'duplicate_in_file:lot_no');
  perform import._flag_duplicates(p_batch,
    '($r.normalized ->> ''variant_id'') || ''|'' || ($r.normalized ->> ''lot_no'')',
    'inconsistent:expiry_date', 'count(distinct coalesce(r.normalized ->> ''expiry_date'', '''')) > 1');
end $$;

create or replace function import._validate_opening_ar(p_batch uuid) returns void
language plpgsql set search_path = '' as $$
declare r record; e text[]; v text; c record; v_amount numeric;
begin
  for r in select id, raw from import.rows where batch_id = p_batch order by row_no loop
    e := '{}';
    select * into c from import._customer(import._t(r.raw, 'customer_no'), import._t(r.raw, 'customer_phone'));
    if c.error is not null then e := array_append(e, c.error);
    elsif exists (select 1 from finance.customer_ledger l
                  where l.customer_id = c.customer_id and l.entry_type = 'opening_balance') then
      e := array_append(e, 'already_imported:customer');
    end if;

    -- Positive = the customer owes us; negative = a credit in the customer's favour.
    v := import._t(r.raw, 'amount');
    v_amount := import._num(v);
    if v is null then e := array_append(e, 'required:amount');
    elsif v_amount is null or v_amount = 0 or abs(v_amount) > 999999999999.99 then e := array_append(e, 'invalid:amount');
    end if;

    update import.rows set errors = e, normalized = jsonb_strip_nulls(jsonb_build_object(
      'customer_id', c.customer_id, 'amount', v_amount))
    where id = r.id;
  end loop;

  perform import._flag_duplicates(p_batch, '$r.normalized ->> ''customer_id''', 'duplicate_in_file:customer');
end $$;

-- Runs the kind's validation, sets row statuses and batch counts. Returns the summary.
create or replace function import._validate(p_batch uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare v_kind text; v_rows int; v_bad int; v_status text;
begin
  select kind into v_kind from import.batches where id = p_batch;
  case v_kind
    when 'customers' then perform import._validate_customers(p_batch);
    when 'products' then perform import._validate_products(p_batch);
    when 'customer_prices' then perform import._validate_customer_prices(p_batch);
    when 'opening_stock' then perform import._validate_opening_stock(p_batch);
    when 'opening_ar' then perform import._validate_opening_ar(p_batch);
  end case;

  update import.rows set status = case when cardinality(errors) = 0 then 'valid' else 'invalid' end
  where batch_id = p_batch;
  select count(*)::int, (count(*) filter (where status = 'invalid'))::int into v_rows, v_bad
  from import.rows where batch_id = p_batch;
  v_status := case when v_bad = 0 then 'validated' else 'failed' end;

  update import.batches set status = v_status, row_count = v_rows, valid_count = v_rows - v_bad, error_count = v_bad,
         validated_at = now(), failure = null, failure_row_no = null
  where id = p_batch;
  return jsonb_build_object('batch_id', p_batch, 'kind', v_kind, 'status', v_status,
                            'row_count', v_rows, 'valid_count', v_rows - v_bad, 'error_count', v_bad);
end $$;

-- ---------------------------------------------------------------------------
-- 3. Posting per kind (called only by api.import_commit, inside its subtransaction).
--    A failing row re-raises with detail 'import_row=<n>' so the batch records which one.
-- ---------------------------------------------------------------------------
create or replace function import._commit_customers(p_batch uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare r record; n jsonb; v_res jsonb; v_state text; v_msg text; v_count int := 0;
begin
  for r in select id, row_no, normalized from import.rows where batch_id = p_batch order by row_no loop
    n := r.normalized;
    begin
      v_res := api.create_customer(
        p_doctor_name => n ->> 'doctor_name', p_clinic_name => n ->> 'clinic_name',
        p_phone_primary => n ->> 'phone_primary', p_governorate_code => n ->> 'governorate_code',
        p_city => n ->> 'city', p_kind => n ->> 'kind', p_specialty_code => n ->> 'specialty_code',
        p_phone_secondary => n ->> 'phone_secondary', p_email => n ->> 'email',
        p_address_line => n ->> 'address_line', p_source => 'import', p_notes => n ->> 'notes',
        p_territory_id => (n ->> 'territory_id')::uuid, p_owner_employee_id => (n ->> 'owner_employee_id')::uuid,
        p_client_ref => r.id, p_display_name => n ->> 'display_name');
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      raise exception using message = v_msg, errcode = v_state, detail = 'import_row=' || r.row_no;
    end;
    update import.rows set result = jsonb_build_object('customer_id', v_res ->> 'customer_id',
                                                       'customer_no', v_res ->> 'customer_no')
    where id = r.id;
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('customers_created', v_count);
end $$;

create or replace function import._commit_products(p_batch uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare
  r record; n jsonb; v_res jsonb; v_state text; v_msg text; v_ids jsonb := '{}'; v_pid uuid; v_vid uuid;
  v_products int := 0; v_variants int := 0;
begin
  -- New products first, in file order (first row of each product describes it).
  for r in select distinct on (normalized ->> 'product_code') row_no, normalized from import.rows
           where batch_id = p_batch and (normalized ->> 'new_product')::boolean
           order by normalized ->> 'product_code', row_no loop
    n := r.normalized; v_pid := gen_random_uuid();
    begin
      perform api.upsert_product(v_pid, (n ->> 'brand_id')::uuid, (n ->> 'category_id')::uuid, n ->> 'product_code',
                                 n ->> 'product_name_en', n ->> 'product_name_ar', null,
                                 (n ->> 'lot_tracked')::boolean, (n ->> 'expiry_tracked')::boolean, false, 'active');
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      raise exception using message = v_msg, errcode = v_state, detail = 'import_row=' || r.row_no;
    end;
    v_ids := v_ids || jsonb_build_object(n ->> 'product_code', v_pid);
    v_products := v_products + 1;
  end loop;

  for r in select id, row_no, normalized from import.rows where batch_id = p_batch order by row_no loop
    n := r.normalized; v_vid := gen_random_uuid();
    v_pid := coalesce((n ->> 'product_id')::uuid, (v_ids ->> (n ->> 'product_code'))::uuid);
    begin
      v_res := api.upsert_variant(v_vid, v_pid, n ->> 'sku', n ->> 'variant_name_en', '{}'::jsonb,
                                  n ->> 'barcode', n ->> 'uom', (n ->> 'reorder_point')::int);
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      raise exception using message = v_msg, errcode = v_state, detail = 'import_row=' || r.row_no;
    end;
    update import.rows set result = jsonb_build_object('product_id', v_pid, 'variant_id', v_vid) where id = r.id;
    v_variants := v_variants + 1;
  end loop;
  return jsonb_build_object('products_created', v_products, 'variants_created', v_variants);
end $$;

create or replace function import._commit_customer_prices(p_batch uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare
  r record; n jsonb; v_state text; v_msg text; v_ids jsonb := '{}'; v_lid uuid;
  v_lists int := 0; v_items int := 0; v_assign int := 0;
begin
  -- New customer price lists, starting on the earliest assignment date in the file.
  for r in select normalized ->> 'price_list_code' as code, min(row_no) as row_no,
                  min(normalized ->> 'price_list_name') as name, min((normalized ->> 'valid_from')::date) as valid_from
           from import.rows where batch_id = p_batch and (normalized ->> 'new_list')::boolean
           group by 1 order by 2 loop
    v_lid := gen_random_uuid();
    begin
      perform api.upsert_price_list(v_lid, r.code, r.name, 'customer', 100, r.valid_from, null, true);
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      raise exception using message = v_msg, errcode = v_state, detail = 'import_row=' || r.row_no;
    end;
    v_ids := v_ids || jsonb_build_object(r.code, v_lid);
    v_lists := v_lists + 1;
  end loop;

  -- One price per list, SKU and tier (validation guarantees repeats agree).
  for r in select distinct on (normalized ->> 'price_list_code', normalized ->> 'variant_id', normalized ->> 'min_qty')
                  row_no, normalized
           from import.rows where batch_id = p_batch
           order by normalized ->> 'price_list_code', normalized ->> 'variant_id', normalized ->> 'min_qty', row_no loop
    n := r.normalized;
    v_lid := coalesce((n ->> 'price_list_id')::uuid, (v_ids ->> (n ->> 'price_list_code'))::uuid);
    begin
      perform api.set_price_list_item(v_lid, (n ->> 'variant_id')::uuid, (n ->> 'unit_price')::numeric, (n ->> 'min_qty')::int);
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      raise exception using message = v_msg, errcode = v_state, detail = 'import_row=' || r.row_no;
    end;
    v_items := v_items + 1;
  end loop;

  -- One assignment per customer and list.
  for r in select distinct on (normalized ->> 'customer_id', normalized ->> 'price_list_code') row_no, normalized
           from import.rows where batch_id = p_batch
           order by normalized ->> 'customer_id', normalized ->> 'price_list_code', row_no loop
    n := r.normalized;
    v_lid := coalesce((n ->> 'price_list_id')::uuid, (v_ids ->> (n ->> 'price_list_code'))::uuid);
    begin
      perform api.assign_customer_price_list((n ->> 'customer_id')::uuid, v_lid, (n ->> 'valid_from')::date, null);
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      raise exception using message = v_msg, errcode = v_state, detail = 'import_row=' || r.row_no;
    end;
    v_assign := v_assign + 1;
  end loop;

  update import.rows x set result = jsonb_build_object(
    'price_list_id', coalesce((x.normalized ->> 'price_list_id')::uuid, (v_ids ->> (x.normalized ->> 'price_list_code'))::uuid))
  where x.batch_id = p_batch;
  return jsonb_build_object('price_lists_created', v_lists, 'prices_set', v_items, 'assignments', v_assign);
end $$;

-- One goods receipt per warehouse (supplier 'Opening stock (import)'), posted at once:
-- 'receipt' movements per lot through the ledger trigger, like any received shipment.
create or replace function import._commit_opening_stock(p_batch uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare
  w record; v_items jsonb; v_rcpt jsonb; v_receipt uuid; v_state text; v_msg text;
  v_receipts int := 0; v_units bigint := 0; v_lines int := 0;
begin
  for w in select normalized ->> 'warehouse_id' as warehouse_id, min(row_no) as row_no
           from import.rows where batch_id = p_batch group by 1 order by 2 loop
    select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'variant_id', normalized ->> 'variant_id', 'lot_no', normalized ->> 'lot_no',
             'expiry_date', normalized ->> 'expiry_date', 'quantity', (normalized ->> 'quantity')::int,
             'unit_cost', (normalized ->> 'unit_cost')::numeric)) order by row_no)
      into v_items
    from import.rows where batch_id = p_batch and normalized ->> 'warehouse_id' = w.warehouse_id;
    begin
      v_rcpt := api.create_goods_receipt(w.warehouse_id::uuid, 'Opening stock (import)',
                                         'IMPORT-' || upper(left(p_batch::text, 8)), v_items);
      v_receipt := (v_rcpt ->> 'receipt_id')::uuid;
      perform api.post_goods_receipt(v_receipt);
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      raise exception using message = v_msg, errcode = v_state, detail = 'import_warehouse=' || w.warehouse_id;
    end;

    -- Link each staging row to its movement (warehouse + variant + lot is unique in the batch).
    update import.rows x set result = jsonb_build_object(
             'receipt_id', v_receipt, 'receipt_no', v_rcpt ->> 'receipt_no', 'movement_id', m.id, 'lot_id', m.lot_id)
    from inventory.movements m join inventory.lots l on l.id = m.lot_id
    where x.batch_id = p_batch and x.normalized ->> 'warehouse_id' = w.warehouse_id
      and m.source_doc_type = 'receipt' and m.source_doc_id = v_receipt
      and m.variant_id = (x.normalized ->> 'variant_id')::uuid and l.lot_no = x.normalized ->> 'lot_no';
    v_receipts := v_receipts + 1;
  end loop;

  select count(*)::int, coalesce(sum((normalized ->> 'quantity')::bigint), 0) into v_lines, v_units
  from import.rows where batch_id = p_batch;
  return jsonb_build_object('receipts_posted', v_receipts, 'lines', v_lines, 'units', v_units);
end $$;

-- Opening AR: one append-only ledger entry per customer; the balance views derive from it.
create or replace function import._commit_opening_ar(p_batch uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare r record; v_entry bigint; v_count int := 0; v_total numeric := 0; v_state text; v_msg text;
begin
  for r in select id, row_no, normalized from import.rows where batch_id = p_batch order by row_no loop
    begin
      if exists (select 1 from finance.customer_ledger l
                 where l.customer_id = (r.normalized ->> 'customer_id')::uuid and l.entry_type = 'opening_balance') then
        raise exception 'ALREADY_IMPORTED: the customer already has an opening balance' using errcode = 'P0001';
      end if;
      insert into finance.customer_ledger (customer_id, entry_type, amount, source_table, source_id, posted_by)
      values ((r.normalized ->> 'customer_id')::uuid, 'opening_balance', (r.normalized ->> 'amount')::numeric,
              'import.rows', r.id, auth.uid())
      returning id into v_entry;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      raise exception using message = v_msg, errcode = v_state, detail = 'import_row=' || r.row_no;
    end;
    update import.rows set result = jsonb_build_object('ledger_entry_id', v_entry) where id = r.id;
    v_count := v_count + 1;
    v_total := v_total + (r.normalized ->> 'amount')::numeric;
  end loop;
  return jsonb_build_object('entries', v_count, 'total_amount', v_total);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Commands
-- ---------------------------------------------------------------------------
-- Stage a parsed file. p_rows: JSON array (1–5000) of objects {column: text|null}, columns
-- from import._columns(kind). Replaying the same idempotency key with the same rows returns
-- the same batch; with different rows it is a CONFLICT.
create or replace function api.import_create_batch(p_kind text, p_rows jsonb, p_idempotency_key text,
                                                   p_file_name text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_hash text;
  v_existing import.batches%rowtype;
  v_id uuid;
  v_bad text;
  v_count int;
begin
  if p_kind is null or import._columns(p_kind) is null then
    perform authz.require('admin.import.run');
    raise exception 'VALIDATION: unknown import kind %', coalesce(p_kind, '(none)') using errcode = 'P0001';
  end if;
  perform import._require(p_kind);
  if length(v_key) < 8 or length(v_key) > 200 then
    raise exception 'VALIDATION: idempotency key must be 8-200 characters' using errcode = 'P0001';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'VALIDATION: rows must be a JSON array' using errcode = 'P0001';
  end if;
  v_hash := md5(p_rows::text);

  select * into v_existing from import.batches where created_by = v_uid and idempotency_key = v_key;
  if found then
    if v_existing.kind <> p_kind or v_existing.payload_hash <> v_hash then
      raise exception 'CONFLICT: this idempotency key was used for a different file' using errcode = 'P0001';
    end if;
    return jsonb_build_object('batch_id', v_existing.id, 'kind', v_existing.kind, 'status', v_existing.status,
                              'row_count', v_existing.row_count, 'replayed', true);
  end if;

  v_count := jsonb_array_length(p_rows);
  if v_count = 0 then raise exception 'VALIDATION: the file has no data rows' using errcode = 'P0001'; end if;
  if v_count > 5000 then
    raise exception 'VALIDATION: at most 5000 rows per batch (got %); split the file', v_count using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) e where jsonb_typeof(e) <> 'object') then
    raise exception 'VALIDATION: every row must be a JSON object' using errcode = 'P0001';
  end if;
  select k into v_bad from jsonb_array_elements(p_rows) e, jsonb_object_keys(e) k
  where not (k = any(import._columns(p_kind))) limit 1;
  if v_bad is not null then
    raise exception 'VALIDATION: unknown column % for %', left(v_bad, 60), p_kind using errcode = 'P0001';
  end if;
  select c into v_bad from unnest(import._required_columns(p_kind)) c
  where not exists (select 1 from jsonb_array_elements(p_rows) e where e ? c) limit 1;
  if v_bad is not null then
    raise exception 'VALIDATION: missing column % for %', v_bad, p_kind using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) e, jsonb_each(e) kv
             where jsonb_typeof(kv.value) not in ('string', 'null') or length(kv.value #>> '{}') > 2000) then
    raise exception 'VALIDATION: values must be text of at most 2000 characters' using errcode = 'P0001';
  end if;

  insert into import.batches (kind, file_name, row_count, idempotency_key, payload_hash, created_by)
  values (p_kind, left(nullif(btrim(p_file_name), ''), 200), v_count, v_key, v_hash, v_uid)
  on conflict (created_by, idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    -- A concurrent request with the same key won the race: answer as a replay.
    select * into v_existing from import.batches where created_by = v_uid and idempotency_key = v_key;
    if v_existing.kind <> p_kind or v_existing.payload_hash <> v_hash then
      raise exception 'CONFLICT: this idempotency key was used for a different file' using errcode = 'P0001';
    end if;
    return jsonb_build_object('batch_id', v_existing.id, 'kind', v_existing.kind, 'status', v_existing.status,
                              'row_count', v_existing.row_count, 'replayed', true);
  end if;

  insert into import.rows (batch_id, row_no, raw)
  select v_id, e.n::int, e.obj from jsonb_array_elements(p_rows) with ordinality as e(obj, n);

  return jsonb_build_object('batch_id', v_id, 'kind', p_kind, 'status', 'uploaded', 'row_count', v_count,
                            'replayed', false);
end $$;

-- Validate (or re-validate, e.g. after fixing master data) a batch that was not committed.
create or replace function api.import_validate(p_batch_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b import.batches%rowtype;
begin
  perform authz.require('admin.import.run');
  select * into b from import.batches where id = p_batch_id for update;
  if not found then raise exception 'NOT_FOUND: import batch' using errcode = 'P0002'; end if;
  perform import._require(b.kind);
  if b.status = 'committed' then
    raise exception 'ALREADY_COMMITTED: the batch was committed on %', b.committed_at using errcode = 'P0001';
  end if;
  if b.status = 'discarded' then raise exception 'INVALID_STATE: the batch was discarded' using errcode = 'P0001'; end if;
  return import._validate(p_batch_id);
end $$;

-- Post a validated batch: re-validated under the batch lock, then every row in one
-- subtransaction. Returns {status: 'committed' | 'failed', ...}.
create or replace function api.import_commit(p_batch_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  b import.batches%rowtype; v_check jsonb; v_result jsonb; v_state text; v_msg text; v_detail text; v_row int;
begin
  perform authz.require('admin.import.run');
  select * into b from import.batches where id = p_batch_id for update;
  if not found then raise exception 'NOT_FOUND: import batch' using errcode = 'P0002'; end if;
  perform import._require(b.kind);
  if b.status = 'committed' then
    raise exception 'ALREADY_COMMITTED: the batch was committed on %', b.committed_at using errcode = 'P0001';
  end if;
  if b.status <> 'validated' then
    raise exception 'INVALID_STATE: only a validated batch can be committed (status %)', b.status using errcode = 'P0001';
  end if;

  -- Master data may have changed since validation (another batch, a manual edit).
  v_check := import._validate(p_batch_id);
  if (v_check ->> 'error_count')::int > 0 then
    return v_check || jsonb_build_object('committed', false);
  end if;

  begin
    v_result := case b.kind
      when 'customers' then import._commit_customers(p_batch_id)
      when 'products' then import._commit_products(p_batch_id)
      when 'customer_prices' then import._commit_customer_prices(p_batch_id)
      when 'opening_stock' then import._commit_opening_stock(p_batch_id)
      when 'opening_ar' then import._commit_opening_ar(p_batch_id)
    end;
  exception when others then
    -- Everything posted above is rolled back; only the failure record below survives.
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_detail = pg_exception_detail;
    v_row := (substring(v_detail from '^import_row=([0-9]+)$'))::int;
    update import.batches set status = 'failed', failure = left(v_msg, 500), failure_row_no = v_row
    where id = p_batch_id;
    return jsonb_build_object('batch_id', p_batch_id, 'kind', b.kind, 'status', 'failed', 'committed', false,
                              'failure', left(v_msg, 500), 'failure_sqlstate', v_state, 'failure_row_no', v_row);
  end;

  update import.rows set status = 'committed' where batch_id = p_batch_id;
  update import.batches set status = 'committed', committed_count = row_count, committed_at = now(),
         committed_by = auth.uid(), result = v_result, failure = null, failure_row_no = null
  where id = p_batch_id;

  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('import.committed', 'import.batch', p_batch_id,
          jsonb_build_object('batch_id', p_batch_id, 'kind', b.kind, 'rows', b.row_count, 'result', v_result));

  return jsonb_build_object('batch_id', p_batch_id, 'kind', b.kind, 'status', 'committed', 'committed', true,
                            'row_count', b.row_count, 'result', v_result);
end $$;

-- Abandon a batch before commit. Its staged rows (possibly personal data) are deleted;
-- the batch record stays for the history. Discarding twice is a no-op.
create or replace function api.import_discard(p_batch_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b import.batches%rowtype;
begin
  perform authz.require('admin.import.run');
  if not authz.has_global('admin.import.run') then
    raise exception 'PERMISSION_DENIED: admin.import.run needs company-wide scope' using errcode = '42501';
  end if;
  select * into b from import.batches where id = p_batch_id for update;
  if not found then raise exception 'NOT_FOUND: import batch' using errcode = 'P0002'; end if;
  if b.status = 'committed' then
    raise exception 'ALREADY_COMMITTED: a committed batch cannot be discarded' using errcode = 'P0001';
  end if;
  if b.status = 'discarded' then
    return jsonb_build_object('batch_id', p_batch_id, 'status', 'discarded', 'replayed', true);
  end if;
  delete from import.rows where batch_id = p_batch_id;
  update import.batches set status = 'discarded', discarded_at = now(), discarded_by = auth.uid()
  where id = p_batch_id;
  return jsonb_build_object('batch_id', p_batch_id, 'status', 'discarded', 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Read views (security_invoker: the caller's RLS applies — admin.import.run at 'all')
-- ---------------------------------------------------------------------------
create or replace view api.v_import_batches with (security_invoker = true) as
  select b.id, b.kind, b.status, b.file_name, b.row_count, b.valid_count, b.error_count, b.committed_count,
         b.failure, b.failure_row_no, b.result, b.created_by, e.full_name_en as created_by_name_en,
         e.full_name_ar as created_by_name_ar, b.created_at, b.validated_at, b.committed_at, b.discarded_at
  from import.batches b
  left join core.user_profiles up on up.user_id = b.created_by
  left join core.employees e on e.id = up.employee_id;

create or replace view api.v_import_rows with (security_invoker = true) as
  select r.id, r.batch_id, r.row_no, r.raw, r.normalized, r.errors, r.status, r.result
  from import.rows r;

-- ---------------------------------------------------------------------------
-- 6. Privileges. Explicit grants only (never a blanket grant on schema api).
-- ---------------------------------------------------------------------------
revoke all on all functions in schema import from public, anon, authenticated;

grant select on api.v_import_batches, api.v_import_rows to authenticated;
revoke all on api.v_import_batches, api.v_import_rows from anon;

do $$
declare f text;
begin
  foreach f in array array[
    'api.import_create_batch(text, jsonb, text, text)',
    'api.import_validate(uuid)',
    'api.import_commit(uuid)',
    'api.import_discard(uuid)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
