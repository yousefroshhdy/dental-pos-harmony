-- Audit 4, settings hardening (20261104000400_settings_hardening.sql):
--   A-H1  security.* settings need an aal2 session while MFA enforcement is on, so an owner
--         signed in with only a password cannot switch the step-up gate off. Turning
--         enforcement ON at aal1 stays allowed (it only tightens; it helps rollout).
--   A-L3  wf.delegation.max_days / wf.escalation.max_levels are owner-only; every text setting
--         has a maximum length; the secret check finds key-like substrings anywhere (and leaves
--         ordinary company text alone); company.logo_url takes only a same-origin image path.
--   users: a1 owner · a7 admin (admin.settings.manage, not owner)
begin;
select tests.load_fixture();
set constraints all immediate;
select plan(91);

-- Runs a statement; returns 'OK' or 'ERROR <sqlstate> <CODE>' (rolled back in its subtransaction).
create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return 'ERROR ' || sqlstate || ' ' || split_part(sqlerrm, ':', 1);
end $$;
grant execute on function pg_temp.try(text) to authenticated;

-- Signs in p_user with the given aal claim (NULL = no aal claim), the way PostgREST does.
create function pg_temp.sign_in(p_user text, p_aal text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    (jsonb_build_object('sub', p_user, 'role', 'authenticated')
       || case when p_aal is null then '{}'::jsonb else jsonb_build_object('aal', p_aal) end)::text, true);
  perform set_config('request.jwt.claim.sub', p_user, true);
  set local role authenticated;
end $$;
grant execute on function pg_temp.sign_in(text, text) to authenticated;

-- update_setting as an admin on an admin-changeable text key; returns OK or the error code.
create function pg_temp.addr(p_value text) returns text language sql as $$
  select pg_temp.try(format('select api.update_setting(%L, %L::jsonb)', 'company.address_en', to_jsonb(p_value)::text))
$$;
create function pg_temp.logo(p_value text) returns text language sql as $$
  select pg_temp.try(format('select api.update_setting(%L, %L::jsonb)', 'company.logo_url', to_jsonb(p_value)::text))
$$;
grant execute on function pg_temp.addr(text) to authenticated;
grant execute on function pg_temp.logo(text) to authenticated;

create function pg_temp.enforce(p_on boolean) returns void language sql as $$
  update core.system_settings set value = to_jsonb(p_on) where key = 'security.mfa_enforced'
$$;

-- ===========================================================================
-- 1. Privileges
-- ===========================================================================
select ok(not has_function_privilege('authenticated', 'core.setting_looks_like_secret(text)', 'execute'),
  'the secret detector is internal');
select ok(not has_function_privilege('anon', 'core.setting_looks_like_secret(text)', 'execute'), 'and closed to anon');
select ok(not has_function_privilege('authenticated', 'core.validate_setting_value(text, jsonb)', 'execute'),
  'the validator stays internal');
select ok(has_function_privilege('authenticated', 'api.update_setting(text, jsonb, text, timestamptz)', 'execute')
          and not has_function_privilege('anon', 'api.update_setting(text, jsonb, text, timestamptz)', 'execute'),
  'update_setting: authenticated only');
select is((select count(*)::int from pg_proc where oid in (
             'api.update_setting(text, jsonb, text, timestamptz)'::regprocedure,
             'core.validate_setting_value(text, jsonb)'::regprocedure,
             'core.setting_looks_like_secret(text)'::regprocedure)
           and proconfig @> array['search_path=""']), 3, 'the redefined functions pin search_path');

-- ===========================================================================
-- 2. A-H1: the MFA switch cannot be turned off without a verified second factor
-- ===========================================================================
select pg_temp.enforce(true);
select pg_temp.sign_in('00000000-0000-0000-0000-0000000000a1', 'aal1');
select is(pg_temp.try($$select api.update_setting('security.mfa_enforced', 'false'::jsonb, 'x')$$),
  'ERROR 42501 MFA_REQUIRED', 'on: the owner at aal1 cannot switch enforcement off (the audit repro)');
reset role;
select is((select value from core.system_settings where key = 'security.mfa_enforced'), 'true'::jsonb,
  'enforcement is still on');
select is(pg_temp.try($$select authz.require('admin.role.assign')$$), 'ERROR 42501 MFA_REQUIRED',
  'and the gated permission is still refused at aal1');
select pg_temp.sign_in('00000000-0000-0000-0000-0000000000a1', null);
select is(pg_temp.try($$select api.update_setting('security.mfa_enforced', 'false'::jsonb)$$),
  'ERROR 42501 MFA_REQUIRED', 'on: no aal claim counts as not verified');
select is(pg_temp.try($$select api.update_setting('security.mfa_enforced', 'true'::jsonb)$$),
  'ERROR 42501 MFA_REQUIRED', 'on: even re-saving the current value needs aal2 (every security.* write does)');
select pg_temp.sign_in('00000000-0000-0000-0000-0000000000a1', 'aal3');
select is(pg_temp.try($$select api.update_setting('security.mfa_enforced', 'false'::jsonb)$$),
  'ERROR 42501 MFA_REQUIRED', 'on: only the exact claim aal2 counts');
select pg_temp.sign_in('00000000-0000-0000-0000-0000000000a7', 'aal2');
select is(pg_temp.try($$select api.update_setting('security.mfa_enforced', 'false'::jsonb)$$),
  'ERROR 42501 OWNER_ONLY', 'a verified admin is still refused: the key is owner-only');
select pg_temp.sign_in('00000000-0000-0000-0000-0000000000a1', 'aal2');
select is(api.update_setting('security.mfa_enforced', 'false'::jsonb, 'roll back the pilot') ->> 'changed', 'true',
  'on: the owner at aal2 switches enforcement off');
reset role;
select is((select value from core.system_settings where key = 'security.mfa_enforced'), 'false'::jsonb, 'and it is off');
select is((select severity from audit.security_events where event_type = 'setting_changed'
            and details ->> 'key' = 'security.mfa_enforced' order by id desc limit 1), 'critical',
  'the change is a critical security event');

-- Off: turning enforcement ON at aal1 is allowed (it only tightens; owners can then enrol).
select pg_temp.sign_in('00000000-0000-0000-0000-0000000000a1', 'aal1');
select is(api.update_setting('security.mfa_enforced', 'true'::jsonb, 'rollout') ->> 'changed', 'true',
  'off: the owner at aal1 may switch enforcement on');
select is(pg_temp.try($$select api.update_setting('security.mfa_enforced', 'false'::jsonb)$$),
  'ERROR 42501 MFA_REQUIRED', 'but once it is on, the same aal1 session cannot switch it back off');
reset role;
select is((select value from core.system_settings where key = 'security.mfa_enforced'), 'true'::jsonb, 'it stays on');
select pg_temp.enforce(false);
select pg_temp.sign_in('00000000-0000-0000-0000-0000000000a7', 'aal1');
select is(pg_temp.try($$select api.update_setting('security.mfa_enforced', 'true'::jsonb)$$),
  'ERROR 42501 OWNER_ONLY', 'off: an admin still cannot touch security.*');
select is(pg_temp.try($$select api.update_setting('field.geofence_radius_m', '175'::jsonb)$$), 'OK',
  'off: ordinary settings are unaffected at aal1');
reset role;

-- ===========================================================================
-- 3. A-L3: workflow limits are owner-only
-- ===========================================================================
select is((select array_agg(key order by key) from core.setting_definitions
            where key in ('wf.delegation.max_days', 'wf.escalation.max_levels') and owner_only),
  array['wf.delegation.max_days', 'wf.escalation.max_levels'], 'both workflow limits are defined owner-only');
select pg_temp.sign_in('00000000-0000-0000-0000-0000000000a7', 'aal2');
select is(pg_temp.try($$select api.update_setting('wf.delegation.max_days', '365'::jsonb)$$), 'ERROR 42501 OWNER_ONLY',
  'an admin cannot stretch delegations to a year');
select is(pg_temp.try($$select api.update_setting('wf.escalation.max_levels', '10'::jsonb)$$), 'ERROR 42501 OWNER_ONLY',
  'nor change the escalation depth');
select pg_temp.sign_in('00000000-0000-0000-0000-0000000000a1', 'aal1');
select is(api.update_setting('wf.delegation.max_days', '30'::jsonb) -> 'value', '30'::jsonb, 'the owner changes the delegation limit');
select is(api.update_setting('wf.escalation.max_levels', '4'::jsonb) -> 'value', '4'::jsonb, 'and the escalation depth');
select is(pg_temp.try($$select api.update_setting('wf.delegation.max_days', '366'::jsonb)$$), 'ERROR P0001 SETTING_OUT_OF_RANGE',
  'the range still applies to the owner');
reset role;
select tests.clear_authentication();
select throws_like($$insert into core.setting_definitions (key, group_code, value_type, default_value, owner_only,
                       label_en, label_ar, description_en, description_ar)
                     values ('wf.delegation.example', 'workflow', 'integer', '1', false, 'x', 'x', 'x', 'x')$$,
  '%setting_definitions_wf_owner_only%', 'a wf.delegation.* definition cannot be created as admin-changeable');
select is((select count(*)::int from api.v_settings where key like 'wf.%' and not owner_only), 0,
  'the settings screen shows them as owner-only');

-- ===========================================================================
-- 4. A-L3: every text setting has a maximum length
-- ===========================================================================
select is((select count(*)::int from core.setting_definitions where value_type = 'text' and max_value is null), 0,
  'no text setting is unbounded');
select is((select max_value from core.setting_definitions where key = 'company.address_en'), 500::numeric, 'addresses: 500');
select is((select max_value from core.setting_definitions where key = 'company.address_ar'), 500::numeric, 'Arabic address: 500');
select is((select max_value from core.setting_definitions where key = 'company.legal_name_en'), 200::numeric, 'legal names: 200');
select is((select max_value from core.setting_definitions where key = 'company.logo_url'), 200::numeric, 'logo path: 200');
select is((select max_value from core.setting_definitions where key = 'company.phone'), 32::numeric, 'phone: 32');

select pg_temp.sign_in('00000000-0000-0000-0000-0000000000a7', 'aal1');
select is(pg_temp.addr(repeat('شارع ', 100)), 'OK', 'a 500-character address is accepted (trimmed to 499)');
select is(pg_temp.addr(repeat('a b ', 125) || 'c'), 'ERROR P0001 SETTING_OUT_OF_RANGE', 'a 501-character address is refused');
select is(pg_temp.try(format('select api.update_setting(%L, %L::jsonb)', 'company.legal_name_en', to_jsonb(repeat('Ab ', 66) || 'Cd')::text)),
  'OK', 'a 200-character legal name is accepted');
select is(pg_temp.try(format('select api.update_setting(%L, %L::jsonb)', 'company.legal_name_en', to_jsonb(repeat('Ab ', 66) || 'Cde')::text)),
  'ERROR P0001 SETTING_OUT_OF_RANGE', 'a 201-character legal name is refused');
select is(pg_temp.try($$select api.update_setting('company.phone', '"+20 2 2345 6789 ext 1234567890123"'::jsonb)$$),
  'ERROR P0001 SETTING_OUT_OF_RANGE', 'a 33-character phone is refused');
select is(pg_temp.try($$select api.update_setting('company.phone', '"+20 2 2345 6789"'::jsonb)$$), 'OK', 'a normal phone is accepted');
reset role;
-- A text definition added later without max_value still gets the 200-character fallback.
select tests.clear_authentication();
insert into core.setting_definitions (key, group_code, value_type, default_value, owner_only, label_en, label_ar, description_en, description_ar)
values ('company.example_note', 'company', 'text', '""', false, 'x', 'x', 'x', 'x');
select pg_temp.sign_in('00000000-0000-0000-0000-0000000000a7', 'aal1');
select is(pg_temp.try(format('select api.update_setting(%L, %L::jsonb)', 'company.example_note', to_jsonb(repeat('xy ', 66) || 'xy')::text)),
  'OK', 'fallback: 200 characters are accepted');
select is(pg_temp.try(format('select api.update_setting(%L, %L::jsonb)', 'company.example_note', to_jsonb(repeat('xy ', 66) || 'xyz')::text)),
  'ERROR P0001 SETTING_OUT_OF_RANGE', 'fallback: 201 characters are refused');

-- ===========================================================================
-- 5. A-L3: secrets are found anywhere in the value
-- ===========================================================================
select is(pg_temp.addr('xsk_live_0123456789abcdef'), 'ERROR P0001 SETTING_SECRET_REFUSED',
  'a Stripe secret key with one character in front (the audit bypass)');
select is(pg_temp.addr('Our key is sk_live_0123456789abcdef, thanks'), 'ERROR P0001 SETTING_SECRET_REFUSED',
  'a Stripe secret key inside a sentence');
select is(pg_temp.addr('note pk_live_51HqLyjWDarjtT1zdp7dc'), 'ERROR P0001 SETTING_SECRET_REFUSED', 'a pk_live key');
select is(pg_temp.addr('rk_test_abcdefgh12345678 here'), 'ERROR P0001 SETTING_SECRET_REFUSED', 'a restricted test key');
select is(pg_temp.addr('token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'), 'ERROR P0001 SETTING_SECRET_REFUSED',
  'a JWT after a prefix');
select is(pg_temp.addr('see -----BEGIN PRIVATE KEY----- MIIEvQIBADANBg'), 'ERROR P0001 SETTING_SECRET_REFUSED',
  'a private-key header');
select is(pg_temp.addr('x -----BEGIN OPENSSH PRIVATE KEY-----'), 'ERROR P0001 SETTING_SECRET_REFUSED', 'an OpenSSH key header');
select is(pg_temp.addr('hook whsec_9f8e7d6c5b4a3f2e1d0c'), 'ERROR P0001 SETTING_SECRET_REFUSED', 'a webhook signing secret');
select is(pg_temp.addr('gh ghp_0123456789abcdefABCDEF0123456789abcd'), 'ERROR P0001 SETTING_SECRET_REFUSED', 'a GitHub token');
select is(pg_temp.addr('slack:xoxb-123456789012-abcdefABCDEF'), 'ERROR P0001 SETTING_SECRET_REFUSED', 'a Slack token');
select is(pg_temp.addr('aws AKIAIOSFODNN7EXAMPLE'), 'ERROR P0001 SETTING_SECRET_REFUSED', 'an AWS access key id');
select is(pg_temp.addr('k:sk-ant-api03-abcDEF123456ghiJKL789'), 'ERROR P0001 SETTING_SECRET_REFUSED', 'an AI provider key');
select is(pg_temp.addr('id 3f9a8b7c6d5e4f30291a8b7c6d5e4f3029aabbcc'), 'ERROR P0001 SETTING_SECRET_REFUSED', 'a 40-char hex run');
select is(pg_temp.addr('k=Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5'), 'ERROR P0001 SETTING_SECRET_REFUSED', 'a long base64 run');
select is(pg_temp.addr('x A1b2C3d4_E5f6G7h8-I9j0K1l2_M3n4O5p6Q7r8'), 'ERROR P0001 SETTING_SECRET_REFUSED',
  'a long base64url run with separators');
select is(pg_temp.try($$select api.update_setting('company.name', '"sk_live_0123456789abcdef"')$$),
  'ERROR P0001 SETTING_SECRET_REFUSED', 'a bare key is still refused');

-- Ordinary company text is not mistaken for a secret.
select is(pg_temp.addr('١٢ شارع التحرير، الدقي، الجيزة ١٢٦١١، جمهورية مصر العربية'), 'OK', 'an Arabic address');
select is(pg_temp.addr('12 El-Tahrir St., Dokki, Giza 12611, Egypt. Building 4B, Floor 3, Apt 12'), 'OK', 'an English address');
select is(pg_temp.addr('Desk_Reference-Task_Management office, 2nd floor'), 'OK', 'words that merely contain sk_ / sk-');
select is(pg_temp.addr('Tel +20 2 2345 6789 / +20 100 123 4567 / 0223456789'), 'OK', 'phone numbers');
select is(pg_temp.addr('PO Box 12345678901234567890 Cairo'), 'OK', 'a long number (not hex-length)');
select is(pg_temp.addr('Honest Dental Supplies S.A.E. (شركة مساهمة مصرية)'), 'OK', 'a mixed legal name');
select is(pg_temp.addr('sales@honest-dental.example, https://honest-dental.example/contact'), 'OK', 'an email and a URL');
select is(pg_temp.try($$select api.update_setting('company.name', '"Honest® Dental"')$$), 'OK', 'a company name');
reset role;
select is(core.setting_looks_like_secret('/brand/honest-logo-primary-horizontal-2026.svg'), false, 'a long logo path');
select is(core.setting_looks_like_secret('STD-2026'), false, 'a plan code');
select is(core.setting_looks_like_secret('123-456-789'), false, 'a tax registration number');

-- ===========================================================================
-- 6. A-L3: company.logo_url is a same-origin static image path
-- ===========================================================================
select is((select description_en from core.setting_definitions where key = 'company.logo_url') ~* 'https', false,
  'the logo description no longer asks for an https URL');
select pg_temp.sign_in('00000000-0000-0000-0000-0000000000a7', 'aal1');
select is(pg_temp.logo('/brand/logo.png'), 'OK', 'a PNG path');
select is(pg_temp.logo('/brand/honest-logo_v2.svg'), 'OK', 'an SVG path');
select is(pg_temp.logo('/images/Logo.JPG'), 'OK', 'a JPG path (extension case does not matter)');
select is(pg_temp.logo('/logo.jpeg'), 'OK', 'a JPEG path');
select is(pg_temp.logo('/static/logo.webp'), 'OK', 'a WebP path');
select is(pg_temp.logo(''), 'OK', 'empty = no logo');
select is((select value from core.system_settings where key = 'company.logo_url'), '""'::jsonb, 'stored as empty');
select is(pg_temp.logo('https://cdn.example.com/logo.png'), 'ERROR P0001 VALIDATION', 'an external https URL');
select is(pg_temp.logo('//cdn.example.com/logo.png'), 'ERROR P0001 VALIDATION', 'a protocol-relative URL');
select is(pg_temp.logo('/api/export/customers'), 'ERROR P0001 VALIDATION', 'an API route (the audit example)');
select is(pg_temp.logo('/api/export/customers.png'), 'ERROR P0001 VALIDATION', 'an API route dressed as an image');
select is(pg_temp.logo('/en/API/x.png'), 'ERROR P0001 VALIDATION', 'an API segment anywhere, any case');
select is(pg_temp.logo('/brand/logo.png?v=2'), 'ERROR P0001 VALIDATION', 'a query string');
select is(pg_temp.logo('/brand/logo.png#top'), 'ERROR P0001 VALIDATION', 'a fragment');
select is(pg_temp.logo('/brand/logo.gif'), 'ERROR P0001 VALIDATION', 'a non-listed extension');
select is(pg_temp.logo('/brand/logo'), 'ERROR P0001 VALIDATION', 'no extension');
select is(pg_temp.logo('brand/logo.png'), 'ERROR P0001 VALIDATION', 'a relative path');
select is(pg_temp.logo('/brand/../api/x.png'), 'ERROR P0001 VALIDATION', 'a dot-dot segment');
select is(pg_temp.logo('/brand/%2e%2e/x.png'), 'ERROR P0001 VALIDATION', 'percent-encoding');
select is(pg_temp.logo('/brand\logo.png'), 'ERROR P0001 VALIDATION', 'a backslash');
select is(pg_temp.logo('javascript:alert(1)//.png'), 'ERROR P0001 VALIDATION', 'a script URL');
reset role;

select * from finish();
rollback;
