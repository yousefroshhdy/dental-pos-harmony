-- Honest OS migration: admin console v2, system settings (roadmap Phase 3 task 1 companion)
--
--   core.setting_definitions      whitelist: one row per changeable key, with its type, range,
--                                 default, owner-only flag and ar/en label + description
--   core.validate_setting_value() type and range validator (internal; not client-callable)
--   api.update_setting()          the ONLY write path for core.system_settings
--   api.v_settings                grouped read model for /admin/settings
--
-- Rules:
--   * A key without a definition cannot be changed (SETTING_NOT_WHITELISTED). New settings
--     arrive with a migration that inserts BOTH the value and its definition.
--   * Owner-only keys (security.*, tracking.*, finance.payment.*, commission.*, money and
--     personal-data retention) need an owner; the rest need admin.settings.manage. The prefix
--     rule is a CHECK on the table, so a definition can never downgrade a sensitive key.
--   * Every change is audited (row trigger + a security event with old/new value and reason)
--     and emits the outbox event `setting.updated` (key + version only: values never leave).
--   * Secrets never live here (system_settings.is_secret CHECK); text values that look like a
--     key or token are refused as well.
-- Additive only: one new table, new policies, new functions and one view.

-- ---------------------------------------------------------------------------
-- 1. Definitions (the whitelist)
-- ---------------------------------------------------------------------------
create table if not exists core.setting_definitions (
  key            text primary key check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  group_code     text not null check (group_code ~ '^[a-z][a-z0-9_]*$'),
  value_type     text not null check (value_type in ('integer','number','boolean','text','enum','enum_array','time_range')),
  min_value      numeric,           -- integer/number: value; text: length; enum_array: item count
  max_value      numeric,
  allowed_values text[],            -- enum / enum_array
  default_value  jsonb not null,
  unit           text,              -- display hint: 'm','s','min','h','days','%','km/h','points'
  owner_only     boolean not null default false,
  is_editable    boolean not null default true,
  label_en       text not null,
  label_ar       text not null,
  description_en text not null,
  description_ar text not null,
  sort_order     int not null default 100,
  check (min_value is null or max_value is null or min_value <= max_value),
  check (value_type not in ('enum','enum_array') or coalesce(array_length(allowed_values, 1), 0) > 0),
  -- Sensitive families are owner-only by construction, whatever a later migration inserts.
  check (owner_only or key !~ '^(security|tracking|finance\.payment|commission)\.')
);
comment on table core.setting_definitions is
  'Whitelist of changeable system settings: type, range, default, owner-only flag. api.update_setting refuses any key not listed here.';

alter table core.setting_definitions enable row level security;
create trigger trg_audit after insert or update or delete on core.setting_definitions
  for each row execute function audit.log_change();

insert into core.setting_definitions
  (key, group_code, value_type, min_value, max_value, allowed_values, default_value, unit, owner_only, is_editable,
   label_en, label_ar, description_en, description_ar, sort_order) values
  -- company
  ('company.name', 'company', 'text', 2, 80, null, '"Honest®"', null, false, true,
   'Company name', 'اسم الشركة',
   'Display name on screens and documents.', 'الاسم الظاهر على الشاشات والمستندات.', 10),
  ('company.timezone', 'company', 'text', 1, 64, null, '"Africa/Cairo"', null, true, false,
   'Business time zone', 'المنطقة الزمنية للعمل',
   'Fixed: every business date is computed in Cairo time.', 'ثابتة: كل تواريخ العمل تُحسب بتوقيت القاهرة.', 20),
  ('company.currency', 'company', 'text', 3, 3, null, '"EGP"', null, true, false,
   'Base currency', 'العملة الأساسية',
   'Fixed: all amounts are in Egyptian pounds.', 'ثابتة: كل المبالغ بالجنيه المصري.', 30),
  -- sales (tax affects money: owner only)
  ('sales.default_vat_pct', 'sales', 'number', 0, 30, null, '14', '%', true, true,
   'Default VAT', 'ضريبة القيمة المضافة الافتراضية',
   'VAT percentage for new products (D-12: confirm with the accountant).', 'نسبة الضريبة للمنتجات الجديدة (القرار D-12: يُراجع مع المحاسب).', 10),
  -- field visits
  ('field.geofence_radius_m', 'field', 'integer', 25, 2000, null, '150', 'm', false, true,
   'Check-in radius', 'نطاق تسجيل الوصول',
   'Maximum distance from the clinic for a verified check-in.', 'أقصى مسافة من العيادة لتسجيل وصول مؤكَّد.', 10),
  ('field.max_accuracy_m', 'field', 'integer', 5, 1000, null, '100', 'm', false, true,
   'GPS accuracy limit', 'حد دقة الموقع',
   'A fix less accurate than this is flagged as low accuracy.', 'أي قراءة أقل دقة من هذا الحد تُعلَّم بأنها ضعيفة الدقة.', 20),
  ('field.location_retention_days', 'field', 'integer', 30, 3650, null, '365', 'days', true, true,
   'Visit GPS retention', 'مدة الاحتفاظ بمواقع الزيارات',
   'Raw visit GPS fixes are deleted after this many days (personal data: owner only).', 'تُحذف قراءات الموقع الخام للزيارات بعد هذه المدة (بيانات شخصية: للمالك فقط).', 30),
  -- offline
  ('offline.max_queue_age_days', 'offline', 'integer', 1, 60, null, '7', 'days', false, true,
   'Offline queue age', 'عمر قائمة العمل دون اتصال',
   'Queued device commands older than this are flagged for review.', 'الأوامر المنتظرة على الجهاز الأقدم من هذه المدة تُعلَّم للمراجعة.', 10),
  -- commissions (money: owner only)
  ('commission.clawback_days', 'commission', 'integer', 0, 365, null, '90', 'days', true, true,
   'Commission clawback window', 'مدة استرداد العمولة',
   'Returns within this many days after collection claw back commission (D-05).', 'المرتجعات خلال هذه المدة بعد التحصيل تسترد العمولة (القرار D-05).', 10),
  -- finance
  ('finance.payment.max_backdate_days_rep', 'finance', 'integer', 0, 31, null, '3', 'days', true, true,
   'Payment back-dating (reps)', 'تأريخ الدفعات بأثر رجعي (المندوبون)',
   'How many Cairo days back a payment date may be when the recorder cannot confirm payments.', 'عدد الأيام (بتوقيت القاهرة) التي يجوز الرجوع إليها في تاريخ الدفعة لمن لا يملك تأكيد الدفعات.', 10),
  ('finance.payment.max_backdate_days_finance', 'finance', 'integer', 0, 366, null, '31', 'days', true, true,
   'Payment back-dating (finance)', 'تأريخ الدفعات بأثر رجعي (المالية)',
   'How many Cairo days back finance may date a payment (never into a closed KPI period).', 'عدد الأيام التي يجوز للمالية الرجوع إليها في تاريخ الدفعة (دون الدخول في فترة مؤشرات مغلقة).', 20),
  -- work-hours tracking (owner only: D-14)
  ('tracking.sample_interval_s', 'tracking', 'integer', 60, 3600, null, '300', 's', true, true,
   'Location interval', 'الفاصل بين نقاط الموقع',
   'Seconds between location points on the device during a shift.', 'الثواني بين نقاط الموقع على الجهاز أثناء الوردية.', 10),
  ('tracking.max_shift_hours', 'tracking', 'integer', 1, 16, null, '10', 'h', true, true,
   'Longest shift', 'أطول وردية',
   'A shift still open after this many hours is closed automatically.', 'الوردية المفتوحة بعد هذه المدة تُغلق تلقائيًا.', 20),
  ('tracking.retention_days', 'tracking', 'integer', 30, 365, null, '90', 'days', true, true,
   'Tracking retention', 'مدة الاحتفاظ بنقاط التتبع',
   'Raw location points are deleted after this many days (minimum 30).', 'تُحذف نقاط الموقع الخام بعد هذه المدة (30 يومًا على الأقل).', 30),
  ('tracking.ping_tolerance_s', 'tracking', 'integer', 0, 3600, null, '120', 's', true, true,
   'Shift edge tolerance', 'سماحية حدود الوردية',
   'Points this many seconds outside the shift window are still accepted.', 'النقاط الواقعة خارج نافذة الوردية بهذه الثواني تُقبل.', 40),
  ('tracking.max_accuracy_m', 'tracking', 'integer', 5, 1000, null, '100', 'm', true, true,
   'Tracking accuracy limit', 'حد دقة التتبع',
   'Less accurate points are flagged and ignored for distance and stops.', 'النقاط الأقل دقة تُعلَّم وتُستبعد من المسافة والتوقفات.', 50),
  ('tracking.max_speed_kmh', 'tracking', 'integer', 50, 400, null, '150', 'km/h', true, true,
   'Impossible speed', 'السرعة غير الممكنة',
   'Faster movement between two points is flagged as impossible travel.', 'الحركة الأسرع بين نقطتين تُعلَّم بأنها انتقال غير ممكن.', 60),
  ('tracking.stop_radius_m', 'tracking', 'integer', 25, 2000, null, '150', 'm', true, true,
   'Stop radius', 'نطاق التوقف',
   'Consecutive points within this radius form a stop.', 'النقاط المتتالية داخل هذا النطاق تُعد توقفًا.', 70),
  ('tracking.stop_min_minutes', 'tracking', 'integer', 5, 240, null, '30', 'min', true, true,
   'Shortest stop', 'أقصر توقف',
   'A stop lasts at least this many minutes.', 'يستمر التوقف هذه الدقائق على الأقل.', 80),
  ('tracking.gap_min_minutes', 'tracking', 'integer', 5, 240, null, '20', 'min', true, true,
   'Gap threshold', 'حد الانقطاع',
   'No point for this many minutes during a shift counts as a gap.', 'غياب النقاط هذه الدقائق أثناء الوردية يُعد انقطاعًا.', 90),
  ('tracking.max_batch', 'tracking', 'integer', 10, 2000, null, '500', 'points', true, true,
   'Upload batch size', 'حجم دفعة الرفع',
   'Most points accepted in one upload.', 'أقصى عدد نقاط يُقبل في رفع واحد.', 100),
  ('tracking.max_points_per_shift', 'tracking', 'integer', 10, 5000, null, '240', 'points', true, true,
   'Points per shift', 'النقاط لكل وردية',
   'Most points stored for one shift.', 'أقصى عدد نقاط يُخزَّن لوردية واحدة.', 110),
  ('tracking.late_point_grace_hours', 'tracking', 'integer', 0, 168, null, '24', 'h', true, true,
   'Late upload grace', 'مهلة الرفع المتأخر',
   'Points are accepted into a closed shift only this many hours after it ended.', 'تُقبل النقاط في وردية مغلقة خلال هذه الساعات فقط بعد انتهائها.', 120),
  ('tracking.max_day_points', 'tracking', 'integer', 100, 10000, null, '1000', 'points', true, true,
   'Points listed per day', 'النقاط المعروضة لكل يوم',
   'Most points listed on one day page (totals still count every point).', 'أقصى عدد نقاط يُعرض في صفحة اليوم (الإجماليات تحسب كل النقاط).', 130),
  ('tracking.work_days', 'tracking', 'enum_array', 1, 7, array['sat','sun','mon','tue','wed','thu','fri'],
   '["sun","mon","tue","wed","thu"]', null, true, true,
   'Working week', 'أيام العمل',
   'The working week (informational).', 'أيام أسبوع العمل (للعلم).', 140),
  ('tracking.work_hours', 'tracking', 'time_range', null, null, null, '{"start":"09:00","end":"17:00"}', null, true, true,
   'Working day', 'ساعات العمل',
   'Start and end of the working day, Cairo time (informational).', 'بداية ونهاية يوم العمل بتوقيت القاهرة (للعلم).', 150)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Validator (internal). Returns the normalised value or raises VALIDATION.
-- ---------------------------------------------------------------------------
create or replace function core.validate_setting_value(p_key text, p_value jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  d core.setting_definitions%rowtype;
  v_num numeric; v_txt text; v_items text[]; v_start text; v_end text;
begin
  select * into d from core.setting_definitions where key = p_key;
  if not found then
    raise exception 'SETTING_NOT_WHITELISTED: % cannot be changed', p_key using errcode = 'P0001';
  end if;
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    raise exception 'VALIDATION: % needs a value', p_key using errcode = 'P0001';
  end if;

  case d.value_type
  when 'integer', 'number' then
    if jsonb_typeof(p_value) <> 'number' then
      raise exception 'VALIDATION: % must be a number', p_key using errcode = 'P0001';
    end if;
    v_num := (p_value #>> '{}')::numeric;
    if d.value_type = 'integer' and v_num <> trunc(v_num) then
      raise exception 'VALIDATION: % must be a whole number', p_key using errcode = 'P0001';
    end if;
    if d.value_type = 'number' and v_num <> round(v_num, 2) then
      raise exception 'VALIDATION: % takes at most two decimals', p_key using errcode = 'P0001';
    end if;
    if (d.min_value is not null and v_num < d.min_value) or (d.max_value is not null and v_num > d.max_value) then
      raise exception 'SETTING_OUT_OF_RANGE: % must be between % and %', p_key, d.min_value, d.max_value using errcode = 'P0001';
    end if;
    return to_jsonb(case when d.value_type = 'integer' then trunc(v_num) else v_num end);

  when 'boolean' then
    if jsonb_typeof(p_value) <> 'boolean' then
      raise exception 'VALIDATION: % must be true or false', p_key using errcode = 'P0001';
    end if;
    return p_value;

  when 'text', 'enum' then
    if jsonb_typeof(p_value) <> 'string' then
      raise exception 'VALIDATION: % must be text', p_key using errcode = 'P0001';
    end if;
    v_txt := btrim(p_value #>> '{}');
    if d.value_type = 'enum' then
      if not (v_txt = any(d.allowed_values)) then
        raise exception 'VALIDATION: % is not an allowed value for %', v_txt, p_key using errcode = 'P0001';
      end if;
      return to_jsonb(v_txt);
    end if;
    if v_txt ~ '[[:cntrl:]]' then
      raise exception 'VALIDATION: % contains control characters', p_key using errcode = 'P0001';
    end if;
    if (d.min_value is not null and length(v_txt) < d.min_value) or (d.max_value is not null and length(v_txt) > d.max_value) then
      raise exception 'SETTING_OUT_OF_RANGE: % must be % to % characters', p_key, d.min_value, d.max_value using errcode = 'P0001';
    end if;
    -- Secrets never live in settings (CLAUDE.md rule 12): refuse anything shaped like a key or token.
    if v_txt ~* '(-----BEGIN|^eyJ[A-Za-z0-9_-]{8,}\.|^(sk|pk|rk|whsec|ghp|xox[a-z])[_-][A-Za-z0-9_-]{8,}|^[A-Za-z0-9+/_=-]{32,}$)' then
      raise exception 'SETTING_SECRET_REFUSED: % looks like a secret; secrets belong in the server environment', p_key
        using errcode = 'P0001';
    end if;
    return to_jsonb(v_txt);

  when 'enum_array' then
    if jsonb_typeof(p_value) <> 'array' or exists (select 1 from jsonb_array_elements(p_value) e where jsonb_typeof(e) <> 'string') then
      raise exception 'VALIDATION: % must be a list of values', p_key using errcode = 'P0001';
    end if;
    select array_agg(distinct x) into v_items from jsonb_array_elements_text(p_value) x;
    v_items := coalesce(v_items, '{}');
    if not (v_items <@ d.allowed_values) then
      raise exception 'VALIDATION: % has a value outside %', p_key, d.allowed_values using errcode = 'P0001';
    end if;
    if (d.min_value is not null and cardinality(v_items) < d.min_value) or (d.max_value is not null and cardinality(v_items) > d.max_value) then
      raise exception 'SETTING_OUT_OF_RANGE: % needs % to % values', p_key, d.min_value, d.max_value using errcode = 'P0001';
    end if;
    -- Canonical order = the order of allowed_values (e.g. the week from Saturday).
    return (select jsonb_agg(a order by i) from unnest(d.allowed_values) with ordinality as u(a, i) where a = any(v_items));

  when 'time_range' then
    if jsonb_typeof(p_value) <> 'object' or (select count(*) from jsonb_object_keys(p_value)) <> 2
       or jsonb_typeof(p_value -> 'start') is distinct from 'string' or jsonb_typeof(p_value -> 'end') is distinct from 'string' then
      raise exception 'VALIDATION: % must be {"start":"HH:MM","end":"HH:MM"}', p_key using errcode = 'P0001';
    end if;
    v_start := p_value ->> 'start'; v_end := p_value ->> 'end';
    if v_start !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or v_end !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'VALIDATION: % times must be HH:MM', p_key using errcode = 'P0001';
    end if;
    if v_start >= v_end then
      raise exception 'SETTING_OUT_OF_RANGE: % must start before it ends', p_key using errcode = 'P0001';
    end if;
    return jsonb_build_object('start', v_start, 'end', v_end);
  end case;
  raise exception 'VALIDATION: unknown setting type' using errcode = 'P0001';
end $$;

-- ---------------------------------------------------------------------------
-- 3. The write command
-- ---------------------------------------------------------------------------
-- p_expected_updated_at: the updated_at the editor loaded; a different stored value → CONFLICT.
-- Returns {key, value, changed, updated_at}. Setting the current value again is a no-op.
create or replace function api.update_setting(p_key text, p_value jsonb, p_reason text default null,
                                              p_expected_updated_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  d core.setting_definitions%rowtype;
  v_old core.system_settings%rowtype;
  v_new jsonb;
  v_at timestamptz;
begin
  perform authz.require('admin.settings.manage');
  select * into d from core.setting_definitions where key = p_key;
  if not found then
    raise exception 'SETTING_NOT_WHITELISTED: % cannot be changed', p_key using errcode = 'P0001';
  end if;
  if d.owner_only and not authz.is_owner() then
    raise exception 'OWNER_ONLY: % is an owner-only setting', p_key using errcode = '42501';
  end if;
  if not d.is_editable then
    raise exception 'SETTING_READ_ONLY: % is fixed', p_key using errcode = 'P0001';
  end if;
  if p_reason is not null and length(p_reason) > 500 then
    raise exception 'VALIDATION: reason is too long' using errcode = 'P0001';
  end if;
  v_new := core.validate_setting_value(p_key, p_value);

  select * into v_old from core.system_settings where key = p_key for update;
  if found and p_expected_updated_at is not null and v_old.updated_at <> p_expected_updated_at then
    raise exception 'CONFLICT: % was changed by someone else', p_key using errcode = 'P0001';
  end if;
  if found and v_old.value = v_new then
    return jsonb_build_object('key', p_key, 'value', v_new, 'changed', false, 'updated_at', v_old.updated_at);
  end if;

  insert into core.system_settings (key, value, description, updated_by, updated_at)
  values (p_key, v_new, d.description_en, auth.uid(), now())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  returning updated_at into v_at;

  perform authz.log_security_event('setting_changed', case when d.owner_only then 'critical' else 'warning' end,
    jsonb_build_object('key', p_key, 'old', v_old.value, 'new', v_new, 'reason', nullif(btrim(p_reason), '')));
  -- Values never leave through the outbox: consumers re-read what they need.
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('setting.updated', 'core.setting', md5('core.setting:' || p_key)::uuid,
          jsonb_build_object('key', p_key, 'group', d.group_code, 'owner_only', d.owner_only,
                             'updated_at', v_at, 'version', 1));
  return jsonb_build_object('key', p_key, 'value', v_new, 'changed', true, 'updated_at', v_at);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Read model and RLS
-- ---------------------------------------------------------------------------
-- Settings are read by commands (definer) everywhere; clients read them only for administration.
create policy system_settings_admin_select on core.system_settings for select to authenticated
  using ((select authz.has_permission('admin.settings.manage')));
create policy setting_definitions_admin_select on core.setting_definitions for select to authenticated
  using ((select authz.has_permission('admin.settings.manage')));
grant select on core.setting_definitions to authenticated;

-- Every stored or defined key; is_whitelisted = false marks a stored key nobody may change.
create or replace view api.v_settings with (security_invoker = true) as
  select coalesce(d.key, s.key) as key,
         coalesce(d.group_code, split_part(s.key, '.', 1)) as group_code,
         d.value_type, d.min_value, d.max_value, d.allowed_values, d.default_value, d.unit,
         coalesce(d.owner_only, true) as owner_only,
         coalesce(d.is_editable, false) and d.key is not null as is_editable,
         d.key is not null as is_whitelisted,
         d.label_en, d.label_ar,
         coalesce(d.description_en, s.description) as description_en, d.description_ar,
         coalesce(s.value, d.default_value) as value,
         s.value is null or coalesce(s.value = d.default_value, false) as is_default,
         s.updated_at, s.updated_by,
         coalesce(d.sort_order, 1000) as sort_order
  from core.setting_definitions d
  full join core.system_settings s on s.key = d.key;

-- ---------------------------------------------------------------------------
-- 5. Privileges (explicit; never a blanket grant)
-- ---------------------------------------------------------------------------
revoke execute on function core.validate_setting_value(text, jsonb) from public, anon, authenticated;
revoke execute on function api.update_setting(text, jsonb, text, timestamptz) from public, anon;
grant execute on function api.update_setting(text, jsonb, text, timestamptz) to authenticated;
grant select on api.v_settings to authenticated;
