-- Honest OS migration: audit-4 A-LM2, audit row-image masking could be bypassed.
--
-- Findings (20261103001100_audit_row_image_reader.sql):
--   1. Derivable values: the credit approval payload (sales.submit_order) masks balance and
--      credit_limit but showed exposure (= balance + total) and credit_excess
--      (= exposure - credit_limit). With total visible, both masked values could be recomputed.
--   2. Key matching was case-sensitive: Phone, PHONE_PRIMARY, Latitude were not masked.
--   3. Missing spellings: tel, whatsapp, msisdn; geo / location / coordinates objects.
--
-- Fix (additive):
--   * audit.row_image_masks.container_only (default false): the rule masks a key only when its
--     value is an object or array. Used for broad container names (%location%, %geo%, %coord%,
--     %position%, point) so scalar flags like crm.customers.location_verified stay readable.
--   * New mask rows: exposure / excess (derivations of balance and credit limit); tel, whatsapp,
--     msisdn; wider GPS spellings; location and geometry containers.
--   * audit.mask_jsonb matches lower(key) LIKE lower(pattern) and honours container_only;
--     audit.mask_entry passes container_only through. Recursion into nested objects and arrays is
--     unchanged (it already masked at any depth).
--
-- Every other behaviour of the two helpers is unchanged (same signatures, invoker, search_path '').
-- Non-destructive: one added column with a default, new rows, two replaced function bodies.

-- ---------------------------------------------------------------------------
-- 1. Value-type condition on a rule
-- ---------------------------------------------------------------------------
alter table audit.row_image_masks add column if not exists container_only boolean not null default false;
comment on column audit.row_image_masks.container_only is
  'When true the rule masks a matching key only if its value is an object or array (a location or geometry container); scalars under that key stay visible.';
comment on table audit.row_image_masks is
  'Keys masked in audit row images (api.audit_search / api.audit_record_history). Patterns use LIKE, matched case-insensitively against lower(key): % any, \_ a literal underscore.';

-- ---------------------------------------------------------------------------
-- 2. New rules
-- ---------------------------------------------------------------------------
insert into audit.row_image_masks (table_schema, table_name, key_pattern, category, unmask_permission, requires_reveal, container_only) values
  -- Derived from the balance / credit limit (wf.approval_requests.payload of sales.order.discount):
  --   exposure = balance + total; credit_excess = balance + total - credit_limit.
  --   (limit_metrics."wf.decide.credit_limit" = credit_excess is already caught by %credit\_limit%.)
  ('%', '%', '%exposure%',       'balance',      'audit.row_image.unmask', true, false),
  ('%', '%', '%excess%',         'credit_limit', 'audit.row_image.unmask', true, false),
  -- Phones: other spellings (phone and mobile were already covered).
  ('%', '%', 'tel',              'phone',        'audit.row_image.unmask', true, false),
  ('%', '%', 'tel\_%',           'phone',        'audit.row_image.unmask', true, false),
  ('%', '%', '%\_tel',           'phone',        'audit.row_image.unmask', true, false),
  ('%', '%', '%\_tel\_%',        'phone',        'audit.row_image.unmask', true, false),
  ('%', '%', '%whatsapp%',       'phone',        'audit.row_image.unmask', true, false),
  ('%', '%', '%msisdn%',         'phone',        'audit.row_image.unmask', true, false),
  -- GPS scalars: any position of latitude/longitude, prefixed short forms, geohashes.
  ('%', '%', '%latitude%',       'gps',          'audit.row_image.unmask', true, false),
  ('%', '%', '%longitude%',      'gps',          'audit.row_image.unmask', true, false),
  ('%', '%', 'lat\_%',           'gps',          'audit.row_image.unmask', true, false),
  ('%', '%', 'lng\_%',           'gps',          'audit.row_image.unmask', true, false),
  ('%', '%', 'lon\_%',           'gps',          'audit.row_image.unmask', true, false),
  ('%', '%', 'long',             'gps',          'audit.row_image.unmask', true, false),
  ('%', '%', '%geohash%',        'gps',          'audit.row_image.unmask', true, false),
  ('%', '%', 'gps%',             'gps',          'audit.row_image.unmask', true, false),
  ('%', '%', '%\_gps%',          'gps',          'audit.row_image.unmask', true, false),
  ('%', '%', 'location',         'gps',          'audit.row_image.unmask', true, false),  -- "30.04,31.24" strings too
  ('%', '%', '%\_location',      'gps',          'audit.row_image.unmask', true, false),
  ('%', '%', 'coords',           'gps',          'audit.row_image.unmask', true, false),
  ('%', '%', 'coordinates',      'gps',          'audit.row_image.unmask', true, false),
  ('%', '%', '%\_coords',        'gps',          'audit.row_image.unmask', true, false),
  ('%', '%', '%\_coordinates',   'gps',          'audit.row_image.unmask', true, false),
  ('%', '%', '%geom%',           'gps',          'audit.row_image.unmask', true, false),  -- geom, geometry (WKT/WKB strings)
  ('%', '%', '%geography%',      'gps',          'audit.row_image.unmask', true, false),
  -- GPS containers: the whole object/array is hidden ({"geo": {"x": .., "y": ..}}, GeoJSON, [lng, lat]).
  ('%', '%', '%geo%',            'gps',          'audit.row_image.unmask', true, true),
  ('%', '%', '%location%',       'gps',          'audit.row_image.unmask', true, true),
  ('%', '%', '%coord%',          'gps',          'audit.row_image.unmask', true, true),
  ('%', '%', '%position%',       'gps',          'audit.row_image.unmask', true, true),
  ('%', '%', 'point',            'gps',          'audit.row_image.unmask', true, true)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 3. audit.mask_jsonb — from 20261103001100 (its only definition). Changes: case-insensitive
--    match (lower(key) LIKE lower(pattern)); rules with container_only apply to objects/arrays only.
-- ---------------------------------------------------------------------------
create or replace function audit.mask_jsonb(p_value jsonb, p_rules jsonb, p_path text default '')
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_out jsonb; v_m jsonb := '{}'; v_child jsonb; v_path text; v_cat text; r record; i int;
begin
  if p_value is null then
    return jsonb_build_object('v', null, 'm', '{}'::jsonb);
  elsif jsonb_typeof(p_value) = 'object' then
    v_out := '{}';
    for r in select e.key, e.value from jsonb_each(p_value) e loop
      v_path := case when p_path = '' then r.key else p_path || '.' || r.key end;
      select x ->> 'category' into v_cat
      from jsonb_array_elements(p_rules) x
      where lower(r.key) like lower(x ->> 'pattern')
        and (not coalesce((x ->> 'container_only')::boolean, false)
             or jsonb_typeof(r.value) in ('object', 'array'))
      limit 1;
      if v_cat is not null and jsonb_typeof(r.value) <> 'null' then
        v_out := v_out || jsonb_build_object(r.key, '[masked:' || v_cat || ']');
        v_m := v_m || jsonb_build_object(v_path, v_cat);
      else
        v_child := audit.mask_jsonb(r.value, p_rules, v_path);
        v_out := v_out || jsonb_build_object(r.key, v_child -> 'v');
        v_m := v_m || (v_child -> 'm');
      end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    v_out := '[]';
    for i in 0 .. jsonb_array_length(p_value) - 1 loop
      v_child := audit.mask_jsonb(p_value -> i, p_rules, p_path || '[' || i || ']');
      v_out := v_out || jsonb_build_array(v_child -> 'v');
      v_m := v_m || (v_child -> 'm');
    end loop;
  else
    v_out := p_value;
  end if;
  return jsonb_build_object('v', v_out, 'm', v_m);
end $$;

-- ---------------------------------------------------------------------------
-- 4. audit.mask_entry — from 20261103001100 (its only definition). Change: the rules carry
--    container_only.
-- ---------------------------------------------------------------------------
create or replace function audit.mask_entry(p_schema text, p_table text, p_old jsonb, p_new jsonb,
                                            p_held text[], p_reveal boolean)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_mask jsonb; v_reveal jsonb; v_o jsonb; v_n jsonb; v_masked jsonb; v_revealed jsonb := '{}';
begin
  select coalesce(jsonb_agg(jsonb_build_object('pattern', m.key_pattern, 'category', m.category,
                                               'container_only', m.container_only)
                            order by m.category, m.key_pattern) filter (where not m.lifted), '[]'),
         coalesce(jsonb_agg(jsonb_build_object('pattern', m.key_pattern, 'category', m.category,
                                               'container_only', m.container_only)
                            order by m.category, m.key_pattern) filter (where m.lifted and m.requires_reveal), '[]')
  into v_mask, v_reveal
  from (select rm.key_pattern, rm.category, rm.requires_reveal, rm.container_only,
               coalesce(rm.unmask_permission = any(p_held), false)
                 and (not rm.requires_reveal or coalesce(p_reveal, false)) as lifted
        from audit.row_image_masks rm
        where p_schema like rm.table_schema and p_table like rm.table_name) m;

  v_o := audit.mask_jsonb(p_old, v_mask);
  v_n := audit.mask_jsonb(p_new, v_mask);
  v_masked := (v_o -> 'm') || (v_n -> 'm');

  if v_reveal <> '[]'::jsonb then
    -- What the reveal uncovered: keys the reveal rules would have masked, minus keys still masked.
    v_revealed := ((audit.mask_jsonb(p_old, v_reveal) -> 'm') || (audit.mask_jsonb(p_new, v_reveal) -> 'm'))
                  - array(select jsonb_object_keys(v_masked));
  end if;

  return jsonb_build_object(
    'old', case when p_old is null then null else v_o -> 'v' end,
    'new', case when p_new is null then null else v_n -> 'v' end,
    'masked', v_masked,
    'revealed', v_revealed);
end $$;

-- CREATE OR REPLACE keeps privileges; restated so this file stands on its own.
revoke execute on function audit.mask_jsonb(jsonb, jsonb, text) from public, anon, authenticated;
revoke execute on function audit.mask_entry(text, text, jsonb, jsonb, text[], boolean) from public, anon, authenticated;
