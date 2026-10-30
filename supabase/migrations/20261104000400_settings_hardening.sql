-- Honest OS migration: settings hardening (audit 4, findings A-H1 and A-L3).
--
-- A-H1  An owner signed in with only a password (aal1) could switch security.mfa_enforced off
--       and so defeat MFA step-up. api.update_setting now refuses every security.* write unless
--       the session is aal2, whenever enforcement is currently on (MFA_REQUIRED, SQLSTATE 42501,
--       the same code and state as authz.require_mfa). While enforcement is off, an owner may
--       still switch it ON at aal1: that only tightens access and is how rollout starts; the
--       next change (including switching it off again) then needs aal2.
-- A-L3  * wf.delegation.max_days and wf.escalation.max_levels are owner-only (a CHECK keeps them so).
--       * Every text setting has a maximum length (200; 500 for addresses); a text definition
--         without max_value falls back to 200 in the validator.
--       * The secret check looks for key-like substrings anywhere in the value, not only at the
--         start (core.setting_looks_like_secret).
--       * company.logo_url takes only a same-origin static image path (/…/name.png|svg|jpg|jpeg|webp,
--         no //, no /api/, no query); the page CSP (img-src 'self' data: blob:) blocks anything else.
--
-- Additive: data updates of definition rows, one new CHECK, one new internal helper, and
-- CREATE OR REPLACE of core.validate_setting_value and api.update_setting (latest definitions:
-- 20261103000800_admin_settings.sql; all other behaviour is kept).

-- ---------------------------------------------------------------------------
-- 1. Definitions
-- ---------------------------------------------------------------------------
update core.setting_definitions
   set owner_only = true,
       description_en = 'Maximum length of an out-of-office delegation. Owner only.',
       description_ar = 'أقصى مدة لتفويض الموافقات أثناء الغياب. للمالك فقط.'
 where key = 'wf.delegation.max_days';
update core.setting_definitions
   set owner_only = true,
       description_en = 'How many times a waiting approval can move up before it reaches the owners. Owner only.',
       description_ar = 'عدد مرات تصعيد طلب الموافقة قبل وصوله للمالك. للمالك فقط.'
 where key = 'wf.escalation.max_levels';

update core.setting_definitions
   set description_en = 'When on, permissions marked "requires MFA" need a session verified with an authenticator app. Roll out only after users have enrolled. While it is on, changing it needs a verified session too.',
       description_ar = 'عند التفعيل، تحتاج الصلاحيات الحساسة إلى جلسة موثّقة بتطبيق المصادقة. فعّله فقط بعد تسجيل المستخدمين. أثناء التفعيل، يحتاج تغييره أيضًا إلى جلسة موثّقة.'
 where key = 'security.mfa_enforced';

-- Who may approve, and for how long, is an owner decision: never admin-changeable.
alter table core.setting_definitions add constraint setting_definitions_wf_owner_only
  check (owner_only or key !~ '^wf\.(delegation|escalation)\.');

-- Text lengths (characters, after trimming).
update core.setting_definitions set max_value = 500
 where key in ('company.address_en', 'company.address_ar') and max_value is null;
update core.setting_definitions set max_value = 200
 where key in ('company.legal_name_en', 'company.legal_name_ar', 'company.logo_url', 'planning.visit_interval_days')
   and max_value is null;
update core.setting_definitions set max_value = 50
 where key in ('company.tax_registration_no', 'company.commercial_register_no') and max_value is null;
update core.setting_definitions set max_value = 40 where key = 'commission.default_plan_code' and max_value is null;
update core.setting_definitions set max_value = 32 where key = 'company.phone' and max_value is null;
-- Anything left (none today) gets the general text limit.
update core.setting_definitions set max_value = 200 where value_type = 'text' and max_value is null;

update core.setting_definitions
   set label_en = 'Logo path',
       label_ar = 'مسار الشعار',
       description_en = 'Path of an image on this site shown on printed documents, e.g. /brand/logo.svg (.png, .svg, .jpg, .jpeg or .webp). Empty = no logo.',
       description_ar = 'مسار صورة على هذا الموقع تظهر على المستندات المطبوعة، مثل /brand/logo.svg (بامتداد png أو svg أو jpg أو jpeg أو webp). فارغ = بدون شعار.'
 where key = 'company.logo_url';

-- ---------------------------------------------------------------------------
-- 2. Secret detector (internal). True when the text contains something shaped like a key,
--    token or private key ANYWHERE. Ordinary company text (Arabic or English names and
--    addresses, phone and registration numbers, site paths, URLs) does not match.
-- ---------------------------------------------------------------------------
create or replace function core.setting_looks_like_secret(p_text text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  v_run text;
begin
  if p_text is null or p_text = '' then
    return false;
  end if;
  -- PEM / OpenSSH private keys and certificates.
  if p_text ~* '-----BEGIN|PRIVATE KEY-----' then
    return true;
  end if;
  -- JWT / JWS / JWE: base64url of '{"' is 'eyJ' (case-sensitive on purpose).
  if p_text ~ 'eyJ[A-Za-z0-9_-]{10,}' then
    return true;
  end if;
  -- Vendor-prefixed keys, wherever they start.
  if p_text ~ '(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}'
     or p_text ~ 'whsec_[A-Za-z0-9+/=]{8,}'
     or p_text ~ 'gh[pousr]_[A-Za-z0-9]{20,}'
     or p_text ~ 'github_pat_[A-Za-z0-9_]{20,}'
     or p_text ~ 'xox[abposre]-[A-Za-z0-9-]{8,}'
     or p_text ~ '(AKIA|ASIA)[0-9A-Z]{16}'
     or p_text ~ 'AIza[0-9A-Za-z_-]{30,}'
     or p_text ~ 'sk-(ant|proj|live|svcacct)-[A-Za-z0-9_-]{8,}'
     or p_text ~ 'SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}' then
    return true;
  end if;
  -- Generic sk_/pk_/rk_/whsec_/ghp_/xox*- keys at the start of a word (so "Desk_Reference" is fine).
  if p_text ~* '(^|[^a-z0-9])(sk|pk|rk|whsec|ghp|xox[a-z])[_-][a-z0-9_-]{8,}' then
    return true;
  end if;
  -- Long hex run (API keys, HMAC secrets, hashes of credentials).
  if p_text ~ '[0-9A-Fa-f]{32,}' then
    return true;
  end if;
  -- Long base64 run without separators: no word, number or path segment is that long.
  if p_text ~ '[A-Za-z0-9+=]{32,}' then
    return true;
  end if;
  -- Long base64 / base64url run with separators (_ - /): flagged when it looks random, i.e. it mixes
  -- upper case, lower case and digits and often switches from a lower-case letter to an upper-case
  -- letter or digit (words and paths such as /brand/Honest-Logo-2026 almost never do).
  for v_run in select m[1] from regexp_matches(p_text, '([A-Za-z0-9+/=_-]{32,})', 'g') as m loop
    if v_run ~ '[A-Z]' and v_run ~ '[a-z]' and v_run ~ '[0-9]'
       and (select count(*) from regexp_matches(v_run, '[a-z][A-Z0-9]', 'g')) >= 4 then
      return true;
    end if;
  end loop;
  return false;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Validator — from 20261103000800_admin_settings.sql. Changes (text values only): a 200-character
--    fallback when a definition has no max_value; company.logo_url must be a same-origin image
--    path; the secret check uses core.setting_looks_like_secret (unanchored).
-- ---------------------------------------------------------------------------
create or replace function core.validate_setting_value(p_key text, p_value jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  d core.setting_definitions%rowtype;
  v_num numeric; v_txt text; v_items text[]; v_start text; v_end text;
  v_max numeric;
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
    -- Every text value is bounded: a definition without max_value gets 200 characters.
    v_max := coalesce(d.max_value, 200);
    if (d.min_value is not null and length(v_txt) < d.min_value) or length(v_txt) > v_max then
      raise exception 'SETTING_OUT_OF_RANGE: % must be % to % characters', p_key, coalesce(d.min_value, 0), v_max
        using errcode = 'P0001';
    end if;
    -- The logo is loaded by every print view: only a static image on this site (CSP img-src 'self').
    if p_key = 'company.logo_url' and v_txt <> '' and (
         v_txt !~* '^/[a-z0-9._~/-]*\.(png|svg|jpg|jpeg|webp)$'
         or v_txt ~ '^//'
         or v_txt ~* '/api/'
         or v_txt ~ '(^|/)\.\.?(/|$)'
         or v_txt ~ '//') then
      raise exception 'VALIDATION: % must be a path on this site ending in .png, .svg, .jpg, .jpeg or .webp, e.g. /brand/logo.svg',
        p_key using errcode = 'P0001';
    end if;
    -- Secrets never live in settings (CLAUDE.md rule 12): refuse anything containing a key or token.
    if core.setting_looks_like_secret(v_txt) then
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
-- 4. The write command — from 20261103000800_admin_settings.sql. Change: security.* keys need an
--    aal2 session while MFA enforcement is on (A-H1). Everything else is unchanged.
-- ---------------------------------------------------------------------------
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
  -- The MFA switch (and any later security.* key) cannot be loosened by a password-only session:
  -- while enforcement is on, every security.* write needs aal2, owners included. While it is off,
  -- nothing is gated yet, so an owner may switch it on at aal1 (rollout).
  if p_key ~ '^security\.' and authz.mfa_enforced() and authz.session_aal() is distinct from 'aal2' then
    raise exception 'MFA_REQUIRED: % needs a session verified with your authenticator app', p_key
      using errcode = '42501';
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
-- 5. Privileges (explicit; CREATE OR REPLACE keeps existing ones, restated for the sweep)
-- ---------------------------------------------------------------------------
revoke execute on function core.setting_looks_like_secret(text) from public, anon, authenticated;
revoke execute on function core.validate_setting_value(text, jsonb) from public, anon, authenticated;
revoke execute on function api.update_setting(text, jsonb, text, timestamptz) from public, anon;
grant execute on function api.update_setting(text, jsonb, text, timestamptz) to authenticated;
