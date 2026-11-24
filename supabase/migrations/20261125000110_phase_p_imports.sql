-- Honest OS migration: Phase P step 1 (setup and real data), part 2 of 2: imports that accept the
-- owner's old-system data (scripts/legacy/convert-workbook.ts writes the files).
--
--   customers        phone_primary may be empty: the customer is created "phone missing"
--                    (api.v_customer_data_gaps). New optional column legacy_ref = the old system's
--                    account number, kept in integration.external_refs (provider 'legacy_pos').
--   customer_prices  a row with no customer (customer_no, customer_phone and customer_legacy_ref all
--                    empty) sets a price on a STANDARD list, e.g. DEFAULT, the base list every order
--                    falls back to (sales.resolve_list_price). A new code becomes a standard list.
--                    Rows with a customer work as before (customer list + assignment).
--                    New optional column customer_legacy_ref.
--   opening_stock    new optional column cost_unknown = yes: the purchase cost is unknown and is
--                    stored as NULL (never 0). An empty unit_cost without it is still refused when the
--                    catalogue has no cost (an accidental blank is not "unknown").
--   opening_ar       new optional column customer_legacy_ref (the migrated customers mostly have no
--                    phone, and their CUS- numbers are only known after the customers import).
--
-- api.create_goods_receipt accepts an item flag cost_unknown (opening-stock imports only: the caller
-- needs admin.import.run company-wide); inventory.goods_receipt_items.unit_cost becomes nullable
-- (relaxing NOT NULL; inventory.movements.unit_cost was nullable already).
--
-- Every function is restated from its latest definition (20261103000110_import_commands.sql;
-- api.create_goods_receipt from 20261029000300_orders_inventory_workflow.sql); only blocks marked
-- "Phase P" change. Result shapes of existing kinds are unchanged (new counters appear only when
-- non-zero). Tests: supabase/tests/database/55_phase_p_setup.test.sql (suite 34 still passes).

-- ---------------------------------------------------------------------------
-- 1. Columns per kind (new optional columns appended; required columns unchanged)
-- ---------------------------------------------------------------------------
create or replace function import._columns(p_kind text) returns text[]
language sql immutable set search_path = '' as $$
  select case p_kind
    when 'customers' then array['doctor_name','clinic_name','display_name','kind','specialty_code','phone_primary',
                                'phone_secondary','email','governorate_code','city','address_line','territory_code',
                                'rep_employee_no','notes','legacy_ref']
    when 'products' then array['product_code','brand_code','category_code','product_name_en','product_name_ar',
                               'lot_tracked','expiry_tracked','sku','variant_name_en','barcode','uom','reorder_point']
    when 'customer_prices' then array['customer_no','customer_phone','price_list_code','price_list_name','sku',
                                      'unit_price','min_qty','valid_from','customer_legacy_ref']
    when 'opening_stock' then array['warehouse_code','sku','lot_no','expiry_date','quantity','unit_cost','cost_unknown']
    when 'opening_ar' then array['customer_no','customer_phone','amount','customer_legacy_ref']
  end
$$;

-- Old-system references: upper-cased, letters, digits and . _ / - only.
create or replace function import._legacy_ref(p text) returns text
language sql immutable set search_path = '' as $$
  select case when p ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$' then upper(p) end
$$;

-- A customer named by customer_no, phone and/or old-system reference (every one given must agree).
create or replace function import._find_customer(p_no text, p_phone text, p_legacy text, out customer_id uuid, out error text)
language plpgsql stable set search_path = '' as $$
declare v_by_ref uuid; v_ref text; v_archived timestamptz;
begin
  if p_no is null and p_phone is null and p_legacy is null then error := 'required:customer'; return; end if;
  if p_no is not null or p_phone is not null then
    select c.customer_id, c.error into customer_id, error from import._customer(p_no, p_phone) c;
    if error is not null then return; end if;
  end if;
  if p_legacy is not null then
    v_ref := import._legacy_ref(p_legacy);
    if v_ref is null then customer_id := null; error := 'invalid:customer_legacy_ref'; return; end if;
    select x.entity_id into v_by_ref from integration.external_refs x
    where x.provider = 'legacy_pos' and x.entity_type = 'customer' and x.external_id = v_ref;
    if v_by_ref is null then customer_id := null; error := 'unknown:customer_legacy_ref'; return; end if;
    if customer_id is not null and customer_id <> v_by_ref then
      customer_id := null; error := 'mismatch:customer_legacy_ref'; return;
    end if;
    customer_id := v_by_ref;
    select c.archived_at into v_archived from crm.customers c where c.id = customer_id;
    if v_archived is not null then customer_id := null; error := 'inactive:customer'; end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Customers: phone optional (Phase P), legacy_ref
-- ---------------------------------------------------------------------------
create or replace function import._validate_customers(p_batch uuid) returns void
language plpgsql set search_path = '' as $$
declare
  r record; e text[]; v text;
  v_doctor text; v_clinic text; v_display text; v_phone text; v_phone2 text; v_email text;
  v_gov text; v_kind text; v_spec text; v_terr uuid; v_emp uuid; v_ref text;
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

    -- Phase P: an empty phone is allowed; the customer is created "phone missing".
    v := import._t(r.raw, 'phone_primary');
    v_phone := import._phone(v);
    if v is not null and v_phone is null then e := array_append(e, 'invalid:phone_primary');
    elsif v_phone is not null and exists (select 1 from crm.customers c where c.phone_primary = v_phone and c.archived_at is null) then
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

    -- Phase P: the old system's account number, so opening balances and prices can name the customer.
    v_ref := null;
    v := import._t(r.raw, 'legacy_ref');
    if v is not null then
      v_ref := import._legacy_ref(v);
      if v_ref is null then e := array_append(e, 'invalid:legacy_ref');
      elsif exists (select 1 from integration.external_refs x
                    where x.provider = 'legacy_pos' and x.entity_type = 'customer' and x.external_id = v_ref) then
        e := array_append(e, 'exists:legacy_ref');
      end if;
    end if;

    update import.rows set errors = e, normalized = jsonb_strip_nulls(jsonb_build_object(
      'doctor_name', v_doctor, 'clinic_name', v_clinic, 'display_name', v_display, 'kind', v_kind,
      'specialty_code', v_spec, 'phone_primary', v_phone, 'phone_secondary', v_phone2, 'email', v_email,
      'governorate_code', v_gov, 'city', import._t(r.raw, 'city'), 'address_line', import._t(r.raw, 'address_line'),
      'territory_id', v_terr, 'owner_employee_id', v_emp, 'notes', import._t(r.raw, 'notes'),
      'phone_missing', case when v_phone is null then true end, 'legacy_ref', v_ref))
    where id = r.id;
  end loop;

  perform import._flag_duplicates(p_batch, '$r.normalized ->> ''phone_primary''', 'duplicate_in_file:phone_primary');
  perform import._flag_duplicates(p_batch, '$r.normalized ->> ''legacy_ref''', 'duplicate_in_file:legacy_ref');
end $$;

create or replace function import._commit_customers(p_batch uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare r record; n jsonb; v_res jsonb; v_state text; v_msg text; v_count int := 0; v_no_phone int := 0; v_refs int := 0;
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
      -- Phase P: keep the old system's account number next to the new customer.
      if n ? 'legacy_ref' then
        insert into integration.external_refs (entity_type, entity_id, provider, external_id)
        values ('customer', (v_res ->> 'customer_id')::uuid, 'legacy_pos', n ->> 'legacy_ref');
        v_refs := v_refs + 1;
      end if;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      if v_state = '23505' and n ? 'legacy_ref' then
        v_state := 'P0001'; v_msg := 'ALREADY_IMPORTED: this old-system account is already linked to a customer';
      end if;
      raise exception using message = v_msg, errcode = v_state, detail = 'import_row=' || r.row_no;
    end;
    update import.rows set result = jsonb_strip_nulls(jsonb_build_object(
             'customer_id', v_res ->> 'customer_id', 'customer_no', v_res ->> 'customer_no',
             'phone_missing', case when n ? 'phone_missing' then true end))
    where id = r.id;
    v_count := v_count + 1;
    if n ? 'phone_missing' then v_no_phone := v_no_phone + 1; end if;
  end loop;
  return jsonb_strip_nulls(jsonb_build_object('customers_created', v_count,
                                              'phone_missing', nullif(v_no_phone, 0),
                                              'legacy_refs', nullif(v_refs, 0)));
end $$;

-- ---------------------------------------------------------------------------
-- 3. Prices: customer lists (as before) or standard lists such as DEFAULT (Phase P)
-- ---------------------------------------------------------------------------
create or replace function import._validate_customer_prices(p_batch uuid) returns void
language plpgsql set search_path = '' as $$
declare
  r record; e text[]; v text; l catalog.price_lists%rowtype;
  v_cno text; v_cphone text; v_cref text; v_list_only boolean; v_cust uuid; v_cerr text;
  v_code text; v_name text; v_variant uuid; v_vstatus text; v_price numeric; v_min bigint; v_from date;
  v_today date := core.business_date();
begin
  for r in select id, raw from import.rows where batch_id = p_batch order by row_no loop
    e := '{}'; l := null; v_variant := null; v_vstatus := null; v_cust := null; v_cerr := null;
    v_cno := import._t(r.raw, 'customer_no');
    v_cphone := import._t(r.raw, 'customer_phone');
    v_cref := import._t(r.raw, 'customer_legacy_ref');
    -- Phase P: no customer at all = a price on a standard list (the base list).
    v_list_only := v_cno is null and v_cphone is null and v_cref is null;
    if not v_list_only then
      select f.customer_id, f.error into v_cust, v_cerr from import._find_customer(v_cno, v_cphone, v_cref) f;
      if v_cerr is not null then e := array_append(e, v_cerr); end if;
    end if;

    v_name := import._t(r.raw, 'price_list_name');
    v_code := upper(import._t(r.raw, 'price_list_code'));
    if v_code is null then e := array_append(e, 'required:price_list_code');
    elsif v_code !~ '^[A-Z0-9][A-Z0-9._-]{1,39}$' then e := array_append(e, 'invalid:price_list_code');
    else
      select * into l from catalog.price_lists pl where upper(pl.code) = v_code;
      if l.id is not null and l.kind <> (case when v_list_only then 'standard' else 'customer' end) then
        e := array_append(e, 'wrong_kind:price_list_code');
      elsif l.id is null and v_code = 'DEFAULT' and not v_list_only then
        e := array_append(e, 'wrong_kind:price_list_code');   -- DEFAULT is always the standard base list
      end if;
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
    v_from := coalesce(import._date(v), case when v is null then v_today end);
    if v_from is null then e := array_append(e, 'invalid:valid_from');
    elsif v_list_only and l.id is null and v_code = 'DEFAULT' and v_from > v_today then
      e := array_append(e, 'invalid:valid_from');               -- the base list must be current today
    elsif v_cust is not null and l.id is not null and exists (
      select 1 from catalog.customer_price_lists cpl
      where cpl.customer_id = v_cust and cpl.price_list_id = l.id and cpl.valid_from <> v_from
        and daterange(cpl.valid_from, cpl.valid_to, '[]') && daterange(v_from, null, '[]')) then
      e := array_append(e, 'overlap:valid_from');
    end if;

    update import.rows set errors = e, normalized = jsonb_strip_nulls(jsonb_build_object(
      'customer_id', v_cust, 'price_list_code', v_code, 'price_list_id', l.id, 'new_list', l.id is null,
      'price_list_name', case when l.id is null then v_name end, 'variant_id', v_variant, 'sku', upper(import._t(r.raw, 'sku')),
      'unit_price', v_price, 'min_qty', v_min, 'valid_from', v_from, 'list_only', v_list_only))
    where id = r.id;
  end loop;

  -- The same customer, list, SKU and tier twice.
  perform import._flag_duplicates(p_batch,
    '($r.normalized ->> ''customer_id'') || ''|'' || ($r.normalized ->> ''price_list_code'') || ''|'' || ($r.normalized ->> ''sku'') || ''|'' || ($r.normalized ->> ''min_qty'')',
    'duplicate_in_file:sku');
  -- Phase P: the same standard list, SKU and tier twice.
  perform import._flag_duplicates(p_batch,
    'case when ($r.normalized ->> ''list_only'')::boolean then ($r.normalized ->> ''price_list_code'') || ''|'' || ($r.normalized ->> ''sku'') || ''|'' || ($r.normalized ->> ''min_qty'') end',
    'duplicate_in_file:sku');
  -- A list holds one price per SKU and tier, whichever customer row repeats it.
  perform import._flag_duplicates(p_batch,
    '($r.normalized ->> ''price_list_code'') || ''|'' || ($r.normalized ->> ''sku'') || ''|'' || ($r.normalized ->> ''min_qty'')',
    'inconsistent:unit_price', 'count(distinct r.normalized ->> ''unit_price'') > 1');
  -- One start date per customer and list.
  perform import._flag_duplicates(p_batch,
    '($r.normalized ->> ''customer_id'') || ''|'' || ($r.normalized ->> ''price_list_code'')',
    'inconsistent:valid_from', 'count(distinct r.normalized ->> ''valid_from'') > 1');
  -- Phase P: one list code is either a standard list (no customer) or a customer list.
  perform import._flag_duplicates(p_batch, '$r.normalized ->> ''price_list_code''',
    'inconsistent:price_list_code', 'count(distinct r.normalized ->> ''list_only'') > 1');
  -- One name per new list, given on at least one of its rows.
  perform import._flag_duplicates(p_batch,
    'case when ($r.normalized ->> ''new_list'')::boolean then $r.normalized ->> ''price_list_code'' end',
    'inconsistent:price_list_name', 'count(distinct r.normalized ->> ''price_list_name'') > 1');
  perform import._flag_duplicates(p_batch,
    'case when ($r.normalized ->> ''new_list'')::boolean then $r.normalized ->> ''price_list_code'' end',
    'required:price_list_name', 'count(r.normalized ->> ''price_list_name'') = 0');
end $$;

create or replace function import._commit_customer_prices(p_batch uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare
  r record; n jsonb; v_state text; v_msg text; v_ids jsonb := '{}'; v_lid uuid;
  v_lists int := 0; v_items int := 0; v_assign int := 0;
begin
  -- New price lists, starting on the earliest date in the file. Phase P: a list whose rows name no
  -- customer is a standard list (validation guarantees a code is one kind or the other).
  for r in select normalized ->> 'price_list_code' as code, min(row_no) as row_no,
                  min(normalized ->> 'price_list_name') as name, min((normalized ->> 'valid_from')::date) as valid_from,
                  bool_and(coalesce((normalized ->> 'list_only')::boolean, false)) as list_only
           from import.rows where batch_id = p_batch and (normalized ->> 'new_list')::boolean
           group by 1 order by 2 loop
    v_lid := gen_random_uuid();
    begin
      perform api.upsert_price_list(v_lid, r.code, r.name, case when r.list_only then 'standard' else 'customer' end,
                                    100, r.valid_from, null, true);
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

  -- One assignment per customer and list (Phase P: standard-list rows assign nothing).
  for r in select distinct on (normalized ->> 'customer_id', normalized ->> 'price_list_code') row_no, normalized
           from import.rows where batch_id = p_batch and not coalesce((normalized ->> 'list_only')::boolean, false)
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

-- ---------------------------------------------------------------------------
-- 4. Opening stock: cost_unknown (Phase P)
-- ---------------------------------------------------------------------------
create or replace function import._validate_opening_stock(p_batch uuid) returns void
language plpgsql set search_path = '' as $$
declare
  r record; e text[]; v text; w inventory.warehouses%rowtype;
  v_vid uuid; v_vsku text; v_lot_tracked boolean; v_exp_tracked boolean;
  v_lot text; v_exp date; v_lot_exp date; v_qty bigint; v_cost numeric; v_unknown boolean;
  v_today date := core.business_date();
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

    -- Phase P: cost_unknown = yes records an unknown purchase cost (NULL, never 0).
    v := import._t(r.raw, 'cost_unknown');
    v_unknown := coalesce(import._bool(v), case when v is null then false end);
    if v_unknown is null then e := array_append(e, 'invalid:cost_unknown'); v_unknown := false; end if;

    v := import._t(r.raw, 'unit_cost');
    if v_unknown then
      if v is not null then e := array_append(e, 'inconsistent:unit_cost'); end if;
    elsif v is not null then
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
      'expiry_date', v_exp, 'quantity', v_qty, 'unit_cost', v_cost, 'cost_unknown', case when v_unknown then true end))
    where id = r.id;
  end loop;

  perform import._flag_duplicates(p_batch,
    '($r.normalized ->> ''warehouse_id'') || ''|'' || ($r.normalized ->> ''variant_id'') || ''|'' || ($r.normalized ->> ''lot_no'')',
    'duplicate_in_file:lot_no');
  perform import._flag_duplicates(p_batch,
    '($r.normalized ->> ''variant_id'') || ''|'' || ($r.normalized ->> ''lot_no'')',
    'inconsistent:expiry_date', 'count(distinct coalesce(r.normalized ->> ''expiry_date'', '''')) > 1');
end $$;

create or replace function import._commit_opening_stock(p_batch uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare
  w record; v_items jsonb; v_rcpt jsonb; v_receipt uuid; v_state text; v_msg text;
  v_receipts int := 0; v_units bigint := 0; v_lines int := 0; v_unknown int := 0;
begin
  for w in select normalized ->> 'warehouse_id' as warehouse_id, min(row_no) as row_no
           from import.rows where batch_id = p_batch group by 1 order by 2 loop
    select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'variant_id', normalized ->> 'variant_id', 'lot_no', normalized ->> 'lot_no',
             'expiry_date', normalized ->> 'expiry_date', 'quantity', (normalized ->> 'quantity')::int,
             'unit_cost', (normalized ->> 'unit_cost')::numeric,
             'cost_unknown', case when (normalized ->> 'cost_unknown')::boolean then true end)) order by row_no)
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

  select count(*)::int, coalesce(sum((normalized ->> 'quantity')::bigint), 0),
         (count(*) filter (where (normalized ->> 'cost_unknown')::boolean))::int
    into v_lines, v_units, v_unknown
  from import.rows where batch_id = p_batch;
  return jsonb_strip_nulls(jsonb_build_object('receipts_posted', v_receipts, 'lines', v_lines, 'units', v_units,
                                              'cost_unknown_lines', nullif(v_unknown, 0)));
end $$;

-- ---------------------------------------------------------------------------
-- 5. Opening AR: customer_legacy_ref (Phase P)
-- ---------------------------------------------------------------------------
create or replace function import._validate_opening_ar(p_batch uuid) returns void
language plpgsql set search_path = '' as $$
declare r record; e text[]; v text; v_cust uuid; v_cerr text; v_amount numeric;
begin
  for r in select id, raw from import.rows where batch_id = p_batch order by row_no loop
    e := '{}'; v_cust := null; v_cerr := null;
    select f.customer_id, f.error into v_cust, v_cerr
    from import._find_customer(import._t(r.raw, 'customer_no'), import._t(r.raw, 'customer_phone'),
                               import._t(r.raw, 'customer_legacy_ref')) f;
    if v_cerr is not null then e := array_append(e, v_cerr);
    elsif exists (select 1 from finance.customer_ledger l
                  where l.customer_id = v_cust and l.entry_type = 'opening_balance') then
      e := array_append(e, 'already_imported:customer');
    end if;

    -- Positive = the customer owes us; negative = a credit in the customer's favour.
    v := import._t(r.raw, 'amount');
    v_amount := import._num(v);
    if v is null then e := array_append(e, 'required:amount');
    elsif v_amount is null or v_amount = 0 or abs(v_amount) > 999999999999.99 then e := array_append(e, 'invalid:amount');
    end if;

    update import.rows set errors = e, normalized = jsonb_strip_nulls(jsonb_build_object(
      'customer_id', v_cust, 'amount', v_amount))
    where id = r.id;
  end loop;

  perform import._flag_duplicates(p_batch, '$r.normalized ->> ''customer_id''', 'duplicate_in_file:customer');
end $$;

-- ---------------------------------------------------------------------------
-- 6. Goods receipts: an unknown cost for opening stock (Phase P)
-- ---------------------------------------------------------------------------
alter table inventory.goods_receipt_items alter column unit_cost drop not null;
comment on column inventory.goods_receipt_items.unit_cost is
  'Purchase cost per unit. NULL = unknown (opening stock imported with cost_unknown; never stored as 0).';

create or replace function api.create_goods_receipt(p_warehouse_id uuid, p_supplier text, p_shipment_ref text,
                                                    p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid; v_no text; v_rec record; v_variant uuid; v_qty numeric; v_cost numeric; v_exp date; v_lot text;
  v_unknown boolean;
begin
  perform authz.require('inventory.receipt.post');
  if not inventory.in_warehouse_scope('inventory.receipt.post', p_warehouse_id) then
    raise exception 'PERMISSION_DENIED: warehouse not in your scope' using errcode = '42501';
  end if;
  if not exists (select 1 from inventory.warehouses where id = p_warehouse_id and is_active) then
    raise exception 'NOT_FOUND: warehouse' using errcode = 'P0002';
  end if;
  if coalesce(trim(p_supplier), '') = '' then raise exception 'VALIDATION: supplier is required' using errcode = 'P0001'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'VALIDATION: items must be a non-empty JSON array' using errcode = 'P0001';
  end if;

  v_no := core.next_document_no('GRN');
  insert into inventory.goods_receipts (receipt_no, warehouse_id, supplier, shipment_ref, created_by)
  values (v_no, p_warehouse_id, trim(p_supplier), nullif(trim(p_shipment_ref), ''), auth.uid())
  returning id into v_id;

  for v_rec in select e.item, e.n from jsonb_array_elements(p_items) with ordinality as e(item, n) loop
    if jsonb_typeof(v_rec.item) <> 'object' or exists (
         select 1 from jsonb_object_keys(v_rec.item) k
         where k not in ('variant_id','lot_no','expiry_date','quantity','unit_cost','cost_unknown')) then
      raise exception 'VALIDATION: item % may only contain variant_id, lot_no, expiry_date, quantity, unit_cost, cost_unknown', v_rec.n
        using errcode = 'P0001';
    end if;
    v_variant := core.try_cast_uuid(v_rec.item ->> 'variant_id');
    if v_variant is null or not exists (select 1 from catalog.product_variants where id = v_variant) then
      raise exception 'VALIDATION: item % has no valid variant_id', v_rec.n using errcode = 'P0001';
    end if;
    v_lot := nullif(trim(v_rec.item ->> 'lot_no'), '');
    if v_lot is null then raise exception 'VALIDATION: item % lot_no is required (NO-LOT for untracked)', v_rec.n using errcode = 'P0001'; end if;
    if jsonb_typeof(v_rec.item -> 'quantity') is distinct from 'number' then
      raise exception 'VALIDATION: item % quantity must be a number', v_rec.n using errcode = 'P0001';
    end if;
    v_qty := (v_rec.item ->> 'quantity')::numeric;
    if v_qty <> trunc(v_qty) or v_qty <= 0 or v_qty > 1000000 then
      raise exception 'VALIDATION: item % quantity must be a positive whole number', v_rec.n using errcode = 'P0001';
    end if;
    v_exp := null;
    if coalesce(jsonb_typeof(v_rec.item -> 'expiry_date'), 'null') <> 'null' then
      begin
        if (v_rec.item ->> 'expiry_date') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'bad'; end if;
        v_exp := (v_rec.item ->> 'expiry_date')::date;
      exception when others then
        raise exception 'VALIDATION: item % expiry_date must be YYYY-MM-DD', v_rec.n using errcode = 'P0001';
      end;
    end if;
    if v_exp is null and exists (select 1 from catalog.product_variants pv join catalog.products p on p.id = pv.product_id
                                 where pv.id = v_variant and p.is_expiry_tracked) then
      raise exception 'VALIDATION: item % expiry_date is required for this product', v_rec.n using errcode = 'P0001';
    end if;
    -- Phase P: cost_unknown (true) records an unknown cost as NULL. Opening stock only: the caller
    -- must run imports company-wide; a supplier delivery always carries its cost.
    v_unknown := false;
    if coalesce(jsonb_typeof(v_rec.item -> 'cost_unknown'), 'null') <> 'null' then
      if jsonb_typeof(v_rec.item -> 'cost_unknown') <> 'boolean' then
        raise exception 'VALIDATION: item % cost_unknown must be true or false', v_rec.n using errcode = 'P0001';
      end if;
      v_unknown := (v_rec.item ->> 'cost_unknown')::boolean;
    end if;
    if v_unknown then
      if not authz.has_global('admin.import.run') then
        raise exception 'VALIDATION: item % an unknown cost is allowed only for opening stock imports', v_rec.n using errcode = 'P0001';
      end if;
      if coalesce(jsonb_typeof(v_rec.item -> 'unit_cost'), 'null') <> 'null' then
        raise exception 'VALIDATION: item % has a unit_cost and cost_unknown', v_rec.n using errcode = 'P0001';
      end if;
      v_cost := null;
    elsif coalesce(jsonb_typeof(v_rec.item -> 'unit_cost'), 'null') = 'null' then
      select pc.unit_cost into v_cost from catalog.product_costs pc
      where pc.variant_id = v_variant and pc.effective_from <= current_date order by pc.effective_from desc limit 1;
      if v_cost is null then raise exception 'VALIDATION: item % unit_cost is required (no catalogue cost)', v_rec.n using errcode = 'P0001'; end if;
    elsif jsonb_typeof(v_rec.item -> 'unit_cost') <> 'number' or (v_rec.item ->> 'unit_cost')::numeric < 0 then
      raise exception 'VALIDATION: item % unit_cost must be a non-negative number', v_rec.n using errcode = 'P0001';
    else
      v_cost := round((v_rec.item ->> 'unit_cost')::numeric, 2);
    end if;
    insert into inventory.goods_receipt_items (receipt_id, variant_id, lot_no, expiry_date, quantity, unit_cost)
    values (v_id, v_variant, v_lot, v_exp, v_qty::int, v_cost);
  end loop;

  return jsonb_build_object('receipt_id', v_id, 'receipt_no', v_no, 'status', 'draft');
end $$;

-- ---------------------------------------------------------------------------
-- 7. Privileges: internal helpers are not client-callable (same as 20261103000110).
-- ---------------------------------------------------------------------------
revoke all on all functions in schema import from public, anon, authenticated;
revoke execute on function api.create_goods_receipt(uuid, text, text, jsonb) from public, anon;
grant execute on function api.create_goods_receipt(uuid, text, text, jsonb) to authenticated;
